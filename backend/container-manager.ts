import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CONTAINER_HOME, CONTAINER_IDLE_MS, CONTAINER_WORKSPACE, type ContainerState } from "../shared/execution.js";
import { WispBackendError } from "./backend-error.js";
import type { ContainerCli } from "./container-cli.js";

/**
 * The Wisp sandbox image, built on the server from this file the first time a
 * Wisp runs a command. Its tag is derived from the contents, so a changed
 * file builds a new image and containers move to it.
 */
export const SANDBOX_DOCKERFILE = `FROM debian:trixie-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
    bash build-essential ca-certificates curl file git git-lfs jq less nodejs npm \\
    openssh-client procps python3 python3-pip python3-venv ripgrep unzip wget xz-utils zip \\
 && rm -rf /var/lib/apt/lists/*
`;

export const SANDBOX_IMAGE = `wisp-sandbox:${createHash("sha256").update(SANDBOX_DOCKERFILE).digest("hex").slice(0, 12)}`;

/** Bumped when the way containers are created changes, so existing ones are recreated. */
const CONTAINER_LAYOUT_VERSION = 1;
const MEMORY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const CPU_LIMIT = 2;
const PROCESS_LIMIT = 512;
const TMP_SIZE = "1g";
const STOP_TIMEOUT_SECONDS = 5;
/** How long a cancelled command gets to end after its processes are killed, before the client is killed too. */
const KILL_GRACE_MS = 2_000;
const PATH_IN_CONTAINER = [
  `${CONTAINER_HOME}/.local/bin`,
  `${CONTAINER_HOME}/.npm-global/bin`,
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");
/** Git asks this helper for GitHub credentials; it answers with the token passed to each command, if any. */
const GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && test -n "$WISP_GIT_TOKEN" && echo username=x-access-token && echo "password=$WISP_GIT_TOKEN"; }; f';
/**
 * Runs the command in its own process group and records the group, so a
 * cancellation can kill everything it started. Whatever the command left
 * running in the background is killed when it ends.
 */
const RUN_SCRIPT = [
  'id="$1"; command="$2"',
  "mkdir -p /tmp/.wisp-exec",
  'setsid bash -c "$command" </dev/null &',
  "pid=$!",
  'echo "$pid" > "/tmp/.wisp-exec/$id"',
  'wait "$pid"; code=$?',
  'kill -KILL -- "-$pid" 2>/dev/null',
  'rm -f "/tmp/.wisp-exec/$id"',
  'exit "$code"',
].join("\n");
const KILL_SCRIPT = 'pid=$(cat "/tmp/.wisp-exec/$1" 2>/dev/null) && kill -KILL -- "-$pid"';

export interface ContainerSpec {
  /** Names the Wisp's container; stable for the Wisp's lifetime. */
  storageId: string;
  image: string;
  workspaceDirectory: string;
}

export interface ContainerExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds, as the shell tool takes them. */
  timeout?: number;
  gitToken?: string;
}

export interface ContainerManagerOptions {
  cli: () => Promise<ContainerCli | null>;
  /** Tells this server's containers apart from another Wisp server's on the same machine. */
  dataDirectory: string;
  idleMs?: number;
  uid?: number;
  gid?: number;
  cpus?: number;
  memoryBytes?: number;
}

/**
 * Owns the containers Wisps run commands in: one per Wisp, created on its
 * first command, stopped after a while without one, and removed with the Wisp.
 */
export class ContainerManager {
  private readonly installation: string;
  private readonly idleMs: number;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly active = new Map<string, number>();
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly images = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: ContainerManagerOptions) {
    this.installation = createHash("sha256").update(path.resolve(options.dataDirectory)).digest("hex").slice(0, 8);
    this.idleMs = options.idleMs ?? CONTAINER_IDLE_MS;
  }

  containerName(storageId: string): string {
    return `wisp-${this.installation}-${storageId}`;
  }

  async state(storageId: string): Promise<ContainerState> {
    const cli = await this.options.cli();
    if (!cli) return "absent";
    const result = await cli.run(["inspect", "--format", "{{.State.Running}}", this.containerName(storageId)]);
    if (result.exitCode !== 0) return "absent";
    return result.stdout.trim() === "true" ? "running" : "stopped";
  }

  /** Runs a command in the Wisp's container, starting or creating it first. */
  async exec(
    spec: ContainerSpec,
    command: string,
    cwd: string,
    options: ContainerExecOptions,
  ): Promise<{ exitCode: number }> {
    if (options.signal?.aborted) throw new Error("aborted");
    const timeoutMs = resolveTimeoutMs(options.timeout);
    const cli = await this.requireCli();
    this.begin(spec.storageId);
    try {
      await abortable(this.ensureRunning(cli, spec, options.onData), options.signal);
      const name = this.containerName(spec.storageId);
      const execId = randomUUID();
      const args = [
        "exec",
        ...(options.gitToken ? ["-e", "WISP_GIT_TOKEN"] : []),
        "-w",
        cwd,
        name,
        "bash",
        "-c",
        RUN_SCRIPT,
        "wisp-run",
        execId,
        command,
      ];
      // The token reaches the program through its environment, never its arguments, which other users can list.
      const child = cli.stream(args, {
        onData: options.onData,
        ...(options.gitToken ? { env: { WISP_GIT_TOKEN: options.gitToken } } : {}),
      });
      let stopped: "aborted" | "timeout" | undefined;
      const stop = (reason: "aborted" | "timeout") => {
        if (stopped) return;
        stopped = reason;
        void cli.run(["exec", name, "bash", "-c", KILL_SCRIPT, "wisp-kill", execId]);
        setTimeout(() => child.kill(), KILL_GRACE_MS).unref();
      };
      const onAbort = () => stop("aborted");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
      try {
        const exitCode = await child.done;
        if (stopped === "aborted" || options.signal?.aborted) throw new Error("aborted");
        if (stopped === "timeout") throw new Error(`timeout:${options.timeout}`);
        return { exitCode: exitCode ?? 1 };
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      this.end(spec.storageId);
    }
  }

  /** Removes the Wisp's container and everything outside its workspace. The workspace is kept. */
  async remove(storageId: string): Promise<void> {
    this.clearIdle(storageId);
    const cli = await this.options.cli();
    if (!cli) return;
    await this.serialized(storageId, async () => {
      await cli.run(["rm", "-f", this.containerName(storageId)]);
    });
  }

  /** Removes this server's containers whose Wisp no longer exists. */
  async reconcile(storageIds: ReadonlySet<string>): Promise<void> {
    const cli = await this.options.cli();
    if (!cli) return;
    const prefix = `wisp-${this.installation}-`;
    for (const name of await this.listNames(cli, false)) {
      if (name.startsWith(prefix) && !storageIds.has(name.slice(prefix.length))) {
        await cli.run(["rm", "-f", name]);
      }
    }
  }

  /** Stops every running container of this server; they start again on their next command. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const cli = await this.options.cli().catch(() => null);
    if (!cli) return;
    const running = await this.listNames(cli, true);
    if (running.length) await cli.run(["stop", "-t", "1", ...running]);
  }

  private async listNames(cli: ContainerCli, runningOnly: boolean): Promise<string[]> {
    const result = await cli.run([
      "ps",
      ...(runningOnly ? [] : ["-a"]),
      "--filter",
      `label=wisp.installation=${this.installation}`,
      "--format",
      "{{.Names}}",
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async requireCli(): Promise<ContainerCli> {
    const cli = await this.options.cli();
    if (!cli) {
      throw new WispBackendError("unavailable", "Docker or Podman is not available on the server.", true);
    }
    return cli;
  }

  private ensureRunning(cli: ContainerCli, spec: ContainerSpec, onData: (data: Buffer) => void): Promise<void> {
    return this.serialized(spec.storageId, async () => {
      if (this.disposed) throw new WispBackendError("unavailable", "The Wisp server is shutting down.", true);
      const name = this.containerName(spec.storageId);
      const fingerprint = this.fingerprint(cli, spec);
      const inspected = await cli.run([
        "inspect",
        "--format",
        '{{.State.Running}} {{index .Config.Labels "wisp.spec"}}',
        name,
      ]);
      const [running, label] = inspected.stdout.trim().split(" ");
      if (inspected.exitCode === 0 && label === fingerprint) {
        if (running === "true") return;
        const started = await cli.run(["start", name]);
        if (started.exitCode === 0) return;
      }
      if (inspected.exitCode === 0) await cli.run(["rm", "-f", name]);
      await this.ensureImage(cli, spec.image, onData);
      await mkdir(path.join(spec.workspaceDirectory, path.relative(CONTAINER_WORKSPACE, CONTAINER_HOME)), {
        recursive: true,
      });
      const created = await cli.run(this.createArgs(cli, spec, name, fingerprint));
      if (created.exitCode !== 0) {
        throw new WispBackendError(
          "internal_error",
          `The Wisp's container could not be started: ${firstLine(created.stderr)}`,
          true,
        );
      }
    });
  }

  private createArgs(cli: ContainerCli, spec: ContainerSpec, name: string, fingerprint: string): string[] {
    if (spec.workspaceDirectory.includes(",")) {
      throw new WispBackendError("internal_error", "The workspace folder's path cannot be mounted.");
    }
    const uid = this.options.uid ?? process.getuid?.() ?? 1000;
    const gid = this.options.gid ?? process.getgid?.() ?? 1000;
    const cpus = Math.min(this.options.cpus ?? CPU_LIMIT, os.availableParallelism());
    const memory = Math.min(this.options.memoryBytes ?? MEMORY_LIMIT_BYTES, Math.floor(os.totalmem() / 2));
    return [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "wisp.managed=true",
      "--label",
      `wisp.installation=${this.installation}`,
      "--label",
      `wisp.spec=${fingerprint}`,
      "--user",
      `${uid}:${gid}`,
      // Rootless Podman maps the server's user to root inside; keep it mapped to itself so workspace files stay the server's.
      ...(cli.name === "podman" ? ["--userns=keep-id"] : []),
      "--init",
      "--read-only",
      "--tmpfs",
      `/tmp:rw,exec,nosuid,size=${TMP_SIZE}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${PROCESS_LIMIT}`,
      `--memory=${memory}b`,
      `--cpus=${cpus}`,
      "--mount",
      `type=bind,source=${spec.workspaceDirectory},target=${CONTAINER_WORKSPACE}`,
      "-w",
      CONTAINER_WORKSPACE,
      "-e",
      `HOME=${CONTAINER_HOME}`,
      "-e",
      "USER=wisp",
      "-e",
      `PATH=${PATH_IN_CONTAINER}`,
      "-e",
      `NPM_CONFIG_PREFIX=${CONTAINER_HOME}/.npm-global`,
      "-e",
      "GIT_CONFIG_COUNT=1",
      "-e",
      "GIT_CONFIG_KEY_0=credential.https://github.com.helper",
      "-e",
      `GIT_CONFIG_VALUE_0=${GIT_CREDENTIAL_HELPER}`,
      "--entrypoint",
      "sleep",
      spec.image,
      "infinity",
    ];
  }

  private fingerprint(cli: ContainerCli, spec: ContainerSpec): string {
    return createHash("sha256")
      .update(JSON.stringify([CONTAINER_LAYOUT_VERSION, cli.name, spec.image, path.resolve(spec.workspaceDirectory)]))
      .digest("hex")
      .slice(0, 16);
  }

  private ensureImage(cli: ContainerCli, image: string, onData: (data: Buffer) => void): Promise<void> {
    let pending = this.images.get(image);
    if (!pending) {
      pending = this.prepareImage(cli, image, onData).finally(() => this.images.delete(image));
      this.images.set(image, pending);
    }
    return pending;
  }

  private async prepareImage(cli: ContainerCli, image: string, onData: (data: Buffer) => void): Promise<void> {
    if ((await cli.run(["image", "inspect", image])).exitCode === 0) return;
    if (image === SANDBOX_IMAGE) {
      onData(Buffer.from("Building the Wisp sandbox image. This happens once and can take a few minutes.\n"));
      // An empty build context: the image needs nothing from this computer.
      const context = await mkdtemp(path.join(os.tmpdir(), "wisp-image-"));
      try {
        const built = await cli.run(["build", "-q", "-t", image, "-f", "-", context], { input: SANDBOX_DOCKERFILE });
        if (built.exitCode !== 0) {
          throw new WispBackendError(
            "internal_error",
            `The Wisp sandbox image could not be built: ${lastLine(built.stderr || built.stdout)}`,
            true,
          );
        }
      } finally {
        await rm(context, { recursive: true, force: true });
      }
      return;
    }
    onData(Buffer.from(`Downloading the image ${image}.\n`));
    const pulled = await cli.run(["pull", image]);
    if (pulled.exitCode !== 0) {
      throw new WispBackendError(
        "invalid_request",
        `The image ${image} could not be downloaded: ${lastLine(pulled.stderr)}`,
      );
    }
  }

  private serialized(storageId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.preparing.get(storageId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.preparing.set(storageId, settled);
    void settled.then(() => {
      if (this.preparing.get(storageId) === settled) this.preparing.delete(storageId);
    });
    return next;
  }

  private begin(storageId: string): void {
    this.clearIdle(storageId);
    this.active.set(storageId, (this.active.get(storageId) ?? 0) + 1);
  }

  private end(storageId: string): void {
    const remaining = (this.active.get(storageId) ?? 1) - 1;
    if (remaining > 0) {
      this.active.set(storageId, remaining);
      return;
    }
    this.active.delete(storageId);
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(storageId);
      if (this.active.has(storageId)) return;
      void this.options
        .cli()
        .then((cli) => cli?.run(["stop", "-t", String(STOP_TIMEOUT_SECONDS), this.containerName(storageId)]));
    }, this.idleMs);
    timer.unref();
    this.idleTimers.set(storageId, timer);
  }

  private clearIdle(storageId: string): void {
    const timer = this.idleTimers.get(storageId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(storageId);
  }
}

/** Longest timeout a command may ask for; the request's own deadline still applies. */
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  return timeout * 1000;
}

/** Stops waiting on abort; the work itself carries on, so a later command can reuse it. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function firstLine(text: string): string {
  return (text.trim().split("\n")[0] ?? "").slice(0, 300) || "unknown error";
}

function lastLine(text: string): string {
  return (text.trim().split("\n").at(-1) ?? "").slice(0, 300) || "unknown error";
}
