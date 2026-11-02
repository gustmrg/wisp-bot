import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTAINER_CIRCLE_CACHE,
  CONTAINER_HOME,
  CONTAINER_IDLE_MS,
  CONTAINER_WORKSPACE,
  type ContainerState,
} from "../shared/execution.js";
import { WispBackendError } from "./backend-error.js";
import { BROWSER_DOCKERFILE, BROWSER_DRIVER_SCRIPT, BROWSER_IMAGE } from "./browser-driver.js";
import type { AttachedContainerProcess, ContainerCli } from "./container-cli.js";
import {
  EGRESS_GIT_PORT,
  EGRESS_PROXY_HOST,
  EGRESS_PROXY_PORT,
  EGRESS_PROXY_SCRIPT,
  EGRESS_PROXY_SCRIPT_HASH,
  type GitForges,
} from "./egress-proxy.js";

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
const CONTAINER_LAYOUT_VERSION = 4;
const PROXY_URL = `http://${EGRESS_PROXY_HOST}:${EGRESS_PROXY_PORT}`;
/** git sends its hosts' requests to the gateway in the egress proxy, under the forge's name; the gateway adds the token. */
const GIT_GATEWAY_URL = `http://${EGRESS_PROXY_HOST}:${EGRESS_GIT_PORT}/`;
/** Hosts reached without the proxy; the git gateway is on the Wisp's own network. */
const NO_PROXY = `localhost,127.0.0.1,::1,${EGRESS_PROXY_HOST}`;
const PROXY_SCRIPT_TARGET = "/opt/wisp/egress-proxy.cjs";
const BROWSER_DRIVER_TARGET = "/opt/wisp/browser-driver.cjs";
const BROWSER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const BROWSER_PROCESS_LIMIT = 256;
const BROWSER_TMP_SIZE = "512m";
/** The images built on the server rather than pulled, and what to say while one builds. */
const BUILT_IMAGES: Record<string, { dockerfile: string; name: string }> = {
  [SANDBOX_IMAGE]: { dockerfile: SANDBOX_DOCKERFILE, name: "Wisp sandbox image" },
  [BROWSER_IMAGE]: { dockerfile: BROWSER_DOCKERFILE, name: "Wisp browser image" },
};
const PROXY_MEMORY = "256m";
const PROXY_PROCESS_LIMIT = 128;
/** Key that serializes work on the shared egress proxy, apart from any Wisp's own container. */
const EGRESS_KEY = "\u0000egress";
const MEMORY_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const CPU_LIMIT = 2;
const PROCESS_LIMIT = 512;
const TMP_SIZE = "1g";
const STOP_TIMEOUT_SECONDS = 5;
/** How long a browser gets to close Chromium once its input ends, before its client is killed. */
const BROWSER_CLOSE_GRACE_MS = 5_000;
/** How long a cancelled command gets to end after its processes are killed, before the client is killed too. */
const KILL_GRACE_MS = 2_000;
const SYSTEM_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":");
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
/** Folder in the container's /tmp that holds each background process: its command, group, output and exit code. */
const PROCESS_DIRECTORY = "/tmp/.wisp-proc";
/** Most background processes a Wisp may have running at once. */
export const MAX_BACKGROUND_PROCESSES = 8;
/**
 * Background process scripts, run with bash. Each process gets its own
 * session (so it can be killed as a group), writes its output to a log in
 * /tmp, and records its exit code when it ends. They outlive the command that
 * started them, but not the container: it stops after the idle time.
 */
const PROCESS_SCRIPTS = {
  start: [
    `id="$1"; command="$2"; max="$3"; dir="${PROCESS_DIRECTORY}/$id"`,
    "running=0",
    `for other in ${PROCESS_DIRECTORY}/*/; do`,
    '  [ -f "$other/pid" ] && [ ! -f "$other/exit" ] && kill -0 "$(cat "$other/pid")" 2>/dev/null && running=$((running + 1))',
    "done",
    'if [ "$running" -ge "$max" ]; then echo "limit"; exit 3; fi',
    'mkdir -p "$dir"',
    `printf '%s' "$command" > "$dir/cmd"`,
    'date +%s > "$dir/started"',
    "(",
    '  setsid bash -c "$command" </dev/null >"$dir/log" 2>&1 &',
    "  pid=$!",
    '  echo "$pid" > "$dir/pid"',
    '  wait "$pid"',
    '  echo "$?" > "$dir/exit"',
    ") </dev/null >/dev/null 2>&1 &",
    'for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$dir/pid" ] && break; sleep 0.1; done',
    "sleep 1",
    'tail -n 20 "$dir/log" 2>/dev/null',
  ].join("\n"),
  list: [
    `for dir in ${PROCESS_DIRECTORY}/*/; do`,
    '  [ -f "$dir/cmd" ] || continue',
    '  if [ -f "$dir/exit" ]; then state="exited $(cat "$dir/exit")"',
    '  elif kill -0 "$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null; then state="running"',
    '  else state="stopped"; fi',
    `  printf '%s\t%s\t%s\t%s\n' "$(basename "$dir")" "$state" "$(cat "$dir/started")" "$(head -c 200 "$dir/cmd" | tr '\n' ' ')"`,
    "done",
  ].join("\n"),
  log: [`dir="${PROCESS_DIRECTORY}/$1"`, '[ -f "$dir/cmd" ] || exit 4', 'tail -n "$2" "$dir/log" 2>/dev/null'].join(
    "\n",
  ),
  wait: [
    `dir="${PROCESS_DIRECTORY}/$1"; ticks=$(( $2 * 5 ))`,
    '[ -f "$dir/cmd" ] || exit 4',
    'while [ ! -f "$dir/exit" ] && [ "$ticks" -gt 0 ] && kill -0 "$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null; do sleep 0.2; ticks=$((ticks - 1)); done',
    'if [ -f "$dir/exit" ]; then echo "exited $(cat "$dir/exit")"; elif kill -0 "$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null; then echo "running"; else echo "stopped"; fi',
    'tail -n "$3" "$dir/log" 2>/dev/null',
  ].join("\n"),
  kill: [
    `dir="${PROCESS_DIRECTORY}/$1"`,
    '[ -f "$dir/cmd" ] || exit 4',
    'pid=$(cat "$dir/pid" 2>/dev/null) || exit 0',
    'kill -TERM -- "-$pid" 2>/dev/null || exit 0',
    'for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.2; done',
    'kill -KILL -- "-$pid" 2>/dev/null; exit 0',
  ].join("\n"),
} as const;

export type ProcessAction = keyof typeof PROCESS_SCRIPTS;

const KILL_SCRIPT = 'pid=$(cat "/tmp/.wisp-exec/$1" 2>/dev/null) && kill -KILL -- "-$pid"';

/** Marks a container that belongs to a circle's member rather than to a Wisp's own conversation. */
const CIRCLE_KEY_PREFIX = "circle-";

/**
 * Names a member's container in a circle (ADR 041). Hashed so container and
 * network names stay short, and so they cannot be read as a Wisp's.
 */
export function circleContainerKey(circleStorageId: string, wispStorageId: string): string {
  const hash = createHash("sha256").update(`${circleStorageId}/${wispStorageId}`).digest("hex").slice(0, 24);
  return `${CIRCLE_KEY_PREFIX}${hash}`;
}

function isCircleContainerKey(key: string): boolean {
  return key.startsWith(CIRCLE_KEY_PREFIX);
}

export interface ContainerSpec {
  /** Names the container: a Wisp's storage ID, or `circleContainerKey` for a circle's member. */
  storageId: string;
  image: string;
  workspaceDirectory: string;
  /**
   * Whether the container may reach private and local network addresses. When
   * not, it sits on its own network with no route out, and reaches the
   * internet only through the egress proxy, which refuses those addresses.
   */
  localNetwork: boolean;
  /**
   * In a circle, the member's storage ID: members share the workspace, so each
   * has its own home folder in it, and they share a package cache.
   */
  circleMember?: string;
}

function containerHome(spec: Pick<ContainerSpec, "circleMember">): string {
  return spec.circleMember ? path.posix.join(CONTAINER_HOME, spec.circleMember) : CONTAINER_HOME;
}

export interface ContainerExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds, as the shell tool takes them. */
  timeout?: number;
  /** Handed to the git gateway, never to the container; leaving a forge out takes the Wisp's token for it away. */
  git?: GitForges;
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
 * git configuration for one command: github.com, and the GitLab plugin's
 * instance when the Wisp can use it, go to the gateway under the forge's name.
 * Given with every command rather than when the container is created, so it
 * follows the plugins the Wisp can use now.
 */
function gitEnvironment(git: GitForges | undefined): string[] {
  const rewrites: Array<[string, string]> = [["https://github.com/", `${GIT_GATEWAY_URL}github/`]];
  if (git?.gitlab) rewrites.push([`${git.gitlab.upstream}/`, `${GIT_GATEWAY_URL}gitlab/`]);
  return [
    "-e",
    `GIT_CONFIG_COUNT=${rewrites.length}`,
    ...rewrites.flatMap(([from, to], index) => [
      "-e",
      `GIT_CONFIG_KEY_${index}=url.${to}.insteadOf`,
      "-e",
      `GIT_CONFIG_VALUE_${index}=${from}`,
    ]),
  ];
}

/**
 * Owns the containers Wisps run commands in: one per Wisp, created on its
 * first command, stopped after a while without one, and removed with the Wisp.
 * A circle's member has one more for that circle, removed with its network
 * after a while without a command, since each network held counts toward the
 * container program's limit and nothing outside the workspace is kept anyway.
 */
export class ContainerManager {
  private readonly installation: string;
  private readonly idleMs: number;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly active = new Map<string, number>();
  private readonly preparing = new Map<string, Promise<void>>();
  private readonly images = new Map<string, Promise<void>>();
  /** What the git gateway last got for each Wisp network, so it is told again only after a change. */
  private readonly gatewayForges = new Map<string, string>();
  private disposed = false;

  constructor(private readonly options: ContainerManagerOptions) {
    this.installation = createHash("sha256").update(path.resolve(options.dataDirectory)).digest("hex").slice(0, 8);
    this.idleMs = options.idleMs ?? CONTAINER_IDLE_MS;
  }

  containerName(storageId: string): string {
    return `wisp-${this.installation}-${storageId}`;
  }

  networkName(storageId: string): string {
    return `wisp-net-${this.installation}-${storageId}`;
  }

  /** A Wisp's browser, on the Wisp's own network; it lives only as long as the server's process attached to it. */
  browserName(storageId: string): string {
    return `wisp-browser-${this.installation}-${storageId}`;
  }

  /** Not prefixed like Wisp containers, so cleaning up deleted Wisps never matches it. */
  proxyName(): string {
    return `wisp-egress-${this.installation}`;
  }

  /**
   * The proxy's own network, with a route out. Podman's DNS does not answer for
   * outside names on an internal network, so a proxy on only blocked Wisps'
   * networks could resolve nothing. Not prefixed like Wisp networks either.
   */
  proxyNetworkName(): string {
    return `wisp-egress-net-${this.installation}`;
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
      await abortable(this.ensureRunning(cli, spec, options.onData, options.git), options.signal);
      const name = this.containerName(spec.storageId);
      const execId = randomUUID();
      const args = [
        "exec",
        ...gitEnvironment(options.git),
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
      const child = cli.stream(args, { onData: options.onData });
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

  /**
   * Runs one of the background process scripts in the Wisp's container. Only
   * `start` creates or starts the container; the others answer from a
   * container that is already running, and find nothing otherwise.
   */
  async processScript(
    spec: ContainerSpec,
    action: ProcessAction,
    args: ReadonlyArray<string>,
    options: { signal?: AbortSignal; git?: GitForges; onData?: (data: Buffer) => void } = {},
  ): Promise<{ exitCode: number; stdout: string } | null> {
    if (options.signal?.aborted) throw new Error("aborted");
    const cli = await this.requireCli();
    this.begin(spec.storageId);
    try {
      if (action === "start") {
        await abortable(
          this.ensureRunning(cli, spec, options.onData ?? (() => undefined), options.git),
          options.signal,
        );
      } else if ((await this.state(spec.storageId)) !== "running") {
        return null;
      }
      const result = await abortable(
        cli.run([
          "exec",
          ...gitEnvironment(options.git),
          "-w",
          CONTAINER_WORKSPACE,
          this.containerName(spec.storageId),
          "bash",
          "-c",
          PROCESS_SCRIPTS[action],
          `wisp-${action}`,
          ...args,
        ]),
        options.signal,
      );
      return { exitCode: result.exitCode, stdout: result.stdout };
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
      await cli.run(["rm", "-f", this.containerName(storageId), this.browserName(storageId)]);
      await this.removeNetwork(cli, this.networkName(storageId));
    });
  }

  /**
   * Starts the Wisp's browser: a container on the Wisp's own network whose
   * only process is the browser driver, attached to this server's process.
   * Its local network is blocked like the Wisp's commands', through the
   * egress proxy. It needs no port and mounts nothing of the Wisp's: it
   * cannot see the workspace. Ending its input ends the container, which
   * removes itself.
   */
  async startBrowser(
    spec: Pick<ContainerSpec, "storageId" | "localNetwork">,
    handlers: { onStdout: (data: Buffer) => void; onStderr?: (data: Buffer) => void },
    signal?: AbortSignal,
  ): Promise<AttachedContainerProcess> {
    if (signal?.aborted) throw new Error("aborted");
    const cli = await this.requireCli();
    let attached: AttachedContainerProcess | undefined;
    await abortable(
      this.serialized(spec.storageId, async () => {
        if (this.disposed) throw new WispBackendError("unavailable", "The Wisp server is shutting down.", true);
        const ignore = () => undefined;
        // The gateway's token is the commands' business: the browser leaves it as it is.
        await this.ensureEgress(cli, spec, null, ignore);
        await this.ensureImage(cli, BROWSER_IMAGE, ignore);
        const driver = await this.writeScript("browser-driver.cjs", BROWSER_DRIVER_SCRIPT);
        const name = this.browserName(spec.storageId);
        // Left by a server that stopped without closing it.
        await cli.run(["rm", "-f", name]);
        // The caller stopped waiting while the image was built: nobody would use this browser.
        if (signal?.aborted) return;
        attached = cli.attach(this.browserArgs(cli, spec, name, driver), handlers);
      }),
      signal,
    );
    if (!attached) throw new WispBackendError("internal_error", "The browser could not be started.", true);
    return attached;
  }

  /** Ends the browser's input, so its driver closes Chromium and the container goes; removes it if it does not. */
  async closeBrowser(storageId: string, browser: AttachedContainerProcess): Promise<void> {
    const cli = await this.options.cli();
    if (!cli) {
      browser.kill();
      return;
    }
    await this.closeAttached(cli, browser, storageId);
  }

  private async closeAttached(cli: ContainerCli, browser: AttachedContainerProcess, storageId: string): Promise<void> {
    browser.end();
    const timer = setTimeout(() => browser.kill(), BROWSER_CLOSE_GRACE_MS);
    timer.unref();
    const code = await browser.done;
    clearTimeout(timer);
    if (code === null) await cli.run(["rm", "-f", this.browserName(storageId)]);
  }

  /**
   * Removes this server's containers whose Wisp, or circle member, no longer
   * exists. So too circle members' that are not running: their idle timers
   * ended with the server that set them. One in use stays.
   */
  async reconcile(storageIds: ReadonlySet<string>): Promise<void> {
    const cli = await this.options.cli();
    if (!cli) return;
    const running = await this.listNamesIfKnown(cli, true);
    const leftOver = (key: string) =>
      isCircleContainerKey(key) &&
      !this.active.has(key) &&
      running !== null &&
      !running.includes(this.containerName(key));
    const prefixes = [`wisp-${this.installation}-`, `wisp-browser-${this.installation}-`];
    for (const name of await this.listNames(cli, false)) {
      const prefix = prefixes.find((value) => name.startsWith(value));
      if (!prefix) continue;
      const key = name.slice(prefix.length);
      if (!storageIds.has(key) || leftOver(key)) {
        await cli.run(["rm", "-f", name]);
      }
    }
    const networkPrefix = `wisp-net-${this.installation}-`;
    const networks = await cli.run([
      "network",
      "ls",
      "--filter",
      `label=wisp.installation=${this.installation}`,
      "--format",
      "{{.Name}}",
    ]);
    if (networks.exitCode !== 0) return;
    for (const name of networks.stdout.split("\n").map((line) => line.trim())) {
      if (!name.startsWith(networkPrefix)) continue;
      const key = name.slice(networkPrefix.length);
      if (!storageIds.has(key) || leftOver(key)) await this.removeNetwork(cli, name);
    }
  }

  private async removeNetwork(cli: ContainerCli, network: string): Promise<void> {
    // The proxy's address on this network may be given to another Wisp's network later; it must not keep this token.
    const proxy = await this.inspectProxyNetworks(cli);
    const address = proxy?.networks[network];
    if (address) await this.tellGateway(cli, address, null).catch(() => undefined);
    this.gatewayForges.delete(network);
    // The proxy is attached to every Wisp network; a network in use cannot be removed.
    await cli.run(["network", "disconnect", "-f", network, this.proxyName()]);
    await cli.run(["network", "rm", network]);
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
    return (await this.listNamesIfKnown(cli, runningOnly)) ?? [];
  }

  /** null when the container program could not say, which is not the same as none. */
  private async listNamesIfKnown(cli: ContainerCli, runningOnly: boolean): Promise<string[] | null> {
    const result = await cli.run([
      "ps",
      ...(runningOnly ? [] : ["-a"]),
      "--filter",
      `label=wisp.installation=${this.installation}`,
      "--format",
      "{{.Names}}",
    ]);
    if (result.exitCode !== 0) return null;
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

  private ensureRunning(
    cli: ContainerCli,
    spec: ContainerSpec,
    onData: (data: Buffer) => void,
    git: GitForges | undefined,
  ): Promise<void> {
    return this.serialized(spec.storageId, async () => {
      if (this.disposed) throw new WispBackendError("unavailable", "The Wisp server is shutting down.", true);
      const name = this.containerName(spec.storageId);
      const fingerprint = this.fingerprint(cli, spec);
      // Before the Wisp's container: it is created on this network, and needs the proxy for git and, when blocked, to go anywhere.
      await this.ensureEgress(cli, spec, git, onData);
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
      await mkdir(path.join(spec.workspaceDirectory, path.posix.relative(CONTAINER_WORKSPACE, containerHome(spec))), {
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
    const home = containerHome(spec);
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
      "--network",
      this.networkName(spec.storageId),
      ...(spec.localNetwork
        ? []
        : [
            ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].flatMap((variable) => [
              "-e",
              `${variable}=${PROXY_URL}`,
            ]),
            "-e",
            `NO_PROXY=${NO_PROXY}`,
            "-e",
            `no_proxy=${NO_PROXY}`,
            // Node's own fetch honours the variables above only when asked to.
            "-e",
            "NODE_USE_ENV_PROXY=1",
          ]),
      "--mount",
      `type=bind,source=${spec.workspaceDirectory},target=${CONTAINER_WORKSPACE}`,
      "-w",
      CONTAINER_WORKSPACE,
      "-e",
      `HOME=${home}`,
      "-e",
      "USER=wisp",
      "-e",
      `PATH=${home}/.local/bin:${home}/.npm-global/bin:${SYSTEM_PATH}`,
      "-e",
      `NPM_CONFIG_PREFIX=${home}/.npm-global`,
      ...(spec.circleMember
        ? ["-e", `XDG_CACHE_HOME=${CONTAINER_CIRCLE_CACHE}`, "-e", `NPM_CONFIG_CACHE=${CONTAINER_CIRCLE_CACHE}/npm`]
        : []),
      "--entrypoint",
      "sleep",
      spec.image,
      "infinity",
    ];
  }

  private fingerprint(cli: ContainerCli, spec: ContainerSpec): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          CONTAINER_LAYOUT_VERSION,
          cli.name,
          spec.image,
          path.resolve(spec.workspaceDirectory),
          spec.localNetwork,
          // Only in a circle, so a Wisp's own container is not recreated for this.
          ...(spec.circleMember ? [spec.circleMember] : []),
        ]),
      )
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Makes sure the shared egress proxy runs, the Wisp's network exists (with
   * no route out when its local network is blocked), the proxy is on it under
   * the name Wisp containers use for it, and its git gateway has the Wisp's
   * token for requests arriving on that network.
   */
  private ensureEgress(
    cli: ContainerCli,
    spec: Pick<ContainerSpec, "storageId" | "localNetwork">,
    /** null leaves what the gateway has for the Wisp as it is. */
    git: GitForges | undefined | null,
    onData: (data: Buffer) => void,
  ): Promise<void> {
    return this.serialized(EGRESS_KEY, async () => {
      await this.ensureImage(cli, SANDBOX_IMAGE, onData);
      const script = await this.writeScript("egress-proxy.cjs", EGRESS_PROXY_SCRIPT);
      const proxy = this.proxyName();
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([CONTAINER_LAYOUT_VERSION, cli.name, SANDBOX_IMAGE, EGRESS_PROXY_SCRIPT_HASH, script]))
        .digest("hex")
        .slice(0, 16);
      const inspected = await cli.run([
        "inspect",
        "--format",
        '{{.State.Running}} {{index .Config.Labels "wisp.spec"}}',
        proxy,
      ]);
      const [running, label] = inspected.stdout.trim().split(" ");
      let ready = inspected.exitCode === 0 && label === fingerprint && running === "true";
      if (!ready && inspected.exitCode === 0 && label === fingerprint) {
        ready = (await cli.run(["start", proxy])).exitCode === 0;
      }
      if (!ready) {
        if (inspected.exitCode === 0) await cli.run(["rm", "-f", proxy]);
        await this.ensureProxyNetwork(cli);
        const created = await cli.run(this.proxyArgs(cli, proxy, fingerprint, script));
        if (created.exitCode !== 0) {
          throw new WispBackendError(
            "internal_error",
            `The network proxy for Wisp containers could not be started: ${firstLine(created.stderr)}`,
            true,
          );
        }
      }
      const network = this.networkName(spec.storageId);
      const internal = !spec.localNetwork;
      const existing = await cli.run(["network", "inspect", "--format", "{{.Internal}}", network]);
      const matches = existing.exitCode === 0 && existing.stdout.trim() === String(internal);
      if (existing.exitCode === 0 && !matches) {
        // Left from other settings: a blocked Wisp must never sit on a network with a route out.
        await cli.run(["rm", "-f", this.containerName(spec.storageId), this.browserName(spec.storageId)]);
        await this.removeNetwork(cli, network);
      }
      if (!matches) {
        const created = await cli.run([
          "network",
          "create",
          ...(internal ? ["--internal"] : []),
          "--label",
          `wisp.installation=${this.installation}`,
          network,
        ]);
        if (created.exitCode !== 0) {
          throw new WispBackendError(
            "internal_error",
            `The Wisp's container network could not be created: ${firstLine(created.stderr)}`,
            true,
          );
        }
      }
      let attached = await this.inspectProxyNetworks(cli);
      if (!attached?.networks[network]) {
        const connected = await cli.run(["network", "connect", "--alias", EGRESS_PROXY_HOST, network, proxy]);
        if (connected.exitCode !== 0) {
          throw new WispBackendError(
            "internal_error",
            `The network proxy could not join the Wisp's network: ${firstLine(connected.stderr)}`,
            true,
          );
        }
        attached = await this.inspectProxyNetworks(cli);
      }
      const address = attached?.networks[network];
      if (!attached || !address) {
        throw new WispBackendError("internal_error", "The network proxy has no address on the Wisp's network.", true);
      }
      if (git === null) return;
      // A restarted proxy has forgotten every token, so its start time is part of what it was told.
      const forges = git ?? {};
      const told = [attached.startedAt, address, createHash("sha256").update(JSON.stringify(forges)).digest("hex")];
      if (this.gatewayForges.get(network) === told.join(" ")) return;
      this.gatewayForges.delete(network);
      await this.tellGateway(cli, address, forges);
      this.gatewayForges.set(network, told.join(" "));
    });
  }

  private async ensureProxyNetwork(cli: ContainerCli): Promise<void> {
    const network = this.proxyNetworkName();
    if ((await cli.run(["network", "inspect", network])).exitCode === 0) return;
    const created = await cli.run(["network", "create", "--label", `wisp.installation=${this.installation}`, network]);
    if (created.exitCode !== 0) {
      throw new WispBackendError(
        "internal_error",
        `The network proxy's network could not be created: ${firstLine(created.stderr)}`,
        true,
      );
    }
  }

  /** When the proxy started and its address on each network it is on; null when it does not exist. */
  private async inspectProxyNetworks(
    cli: ContainerCli,
  ): Promise<{ startedAt: string; networks: Record<string, string> } | null> {
    const inspected = await cli.run([
      "inspect",
      "--format",
      // Both as JSON: Podman writes the start time with spaces in it.
      "{{json .State.StartedAt}} {{json .NetworkSettings.Networks}}",
      this.proxyName(),
    ]);
    if (inspected.exitCode !== 0) return null;
    const match = /^("(?:[^"\\]|\\.)*") (.*)$/s.exec(inspected.stdout.trim());
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[2]!) as Record<string, { IPAddress?: unknown }> | null;
      const networks: Record<string, string> = {};
      for (const [name, settings] of Object.entries(parsed ?? {})) {
        if (typeof settings?.IPAddress === "string" && settings.IPAddress) networks[name] = settings.IPAddress;
      }
      return { startedAt: JSON.parse(match[1]!) as string, networks };
    } catch {
      return null;
    }
  }

  /**
   * Gives the git gateway the token for each forge for requests arriving on
   * one of the proxy's addresses or, with null, forgets the address. The
   * tokens go to the proxy's control socket on standard input, never in
   * arguments or the environment.
   */
  private async tellGateway(cli: ContainerCli, address: string, forges: GitForges | null): Promise<void> {
    const told = await cli.run(["exec", "-i", this.proxyName(), "node", PROXY_SCRIPT_TARGET, "control"], {
      input: JSON.stringify({ address, forges }),
    });
    if (told.exitCode !== 0) {
      throw new WispBackendError(
        "internal_error",
        `The git gateway could not be given the Wisp's git tokens: ${firstLine(told.stderr)}`,
        true,
      );
    }
  }

  private proxyArgs(cli: ContainerCli, name: string, fingerprint: string, script: string): string[] {
    if (script.includes(","))
      throw new WispBackendError("internal_error", "The proxy script's path cannot be mounted.");
    const uid = this.options.uid ?? process.getuid?.() ?? 1000;
    const gid = this.options.gid ?? process.getgid?.() ?? 1000;
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
      ...(cli.name === "podman" ? ["--userns=keep-id"] : []),
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${PROXY_PROCESS_LIMIT}`,
      `--memory=${PROXY_MEMORY}`,
      "--network",
      this.proxyNetworkName(),
      "--mount",
      `type=bind,source=${script},target=${PROXY_SCRIPT_TARGET},readonly`,
      "-e",
      `WISP_EGRESS_PORT=${EGRESS_PROXY_PORT}`,
      "-e",
      `WISP_GIT_PORT=${EGRESS_GIT_PORT}`,
      "--entrypoint",
      "node",
      SANDBOX_IMAGE,
      PROXY_SCRIPT_TARGET,
    ];
  }

  private browserArgs(
    cli: ContainerCli,
    spec: Pick<ContainerSpec, "storageId" | "localNetwork">,
    name: string,
    driver: string,
  ): string[] {
    if (driver.includes(","))
      throw new WispBackendError("internal_error", "The browser driver's path cannot be mounted.");
    const uid = this.options.uid ?? process.getuid?.() ?? 1000;
    const gid = this.options.gid ?? process.getgid?.() ?? 1000;
    const cpus = Math.min(this.options.cpus ?? CPU_LIMIT, os.availableParallelism());
    const memory = Math.min(BROWSER_MEMORY_BYTES, Math.floor(os.totalmem() / 4));
    return [
      "run",
      "-i",
      "--rm",
      "--name",
      name,
      "--label",
      "wisp.managed=true",
      "--label",
      `wisp.installation=${this.installation}`,
      "--user",
      `${uid}:${gid}`,
      ...(cli.name === "podman" ? ["--userns=keep-id"] : []),
      "--init",
      "--read-only",
      "--tmpfs",
      `/tmp:rw,nosuid,size=${BROWSER_TMP_SIZE}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${BROWSER_PROCESS_LIMIT}`,
      `--memory=${memory}b`,
      `--cpus=${cpus}`,
      "--network",
      this.networkName(spec.storageId),
      "-e",
      "HOME=/tmp",
      // The proxy refuses local and private addresses; a Wisp allowed them goes straight out.
      ...(spec.localNetwork ? [] : ["-e", `WISP_BROWSER_PROXY=${PROXY_URL}`]),
      "--mount",
      `type=bind,source=${driver},target=${BROWSER_DRIVER_TARGET},readonly`,
      "--entrypoint",
      "node",
      BROWSER_IMAGE,
      BROWSER_DRIVER_TARGET,
    ];
  }

  /** A script on disk, where the container program can mount it; rewritten only when it changed. */
  private async writeScript(fileName: string, contents: string): Promise<string> {
    const file = path.join(path.resolve(this.options.dataDirectory), "containers", fileName);
    if ((await readFile(file, "utf8").catch(() => null)) !== contents) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, { mode: 0o644 });
    }
    return file;
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
    const builtImage = BUILT_IMAGES[image];
    if (builtImage) {
      onData(Buffer.from(`Building the ${builtImage.name}. This happens once and can take a few minutes.\n`));
      // An empty build context: the image needs nothing from this computer.
      const context = await mkdtemp(path.join(os.tmpdir(), "wisp-image-"));
      try {
        const built = await cli.run(["build", "-q", "-t", image, "-f", "-", context], { input: builtImage.dockerfile });
        if (built.exitCode !== 0) {
          throw new WispBackendError(
            "internal_error",
            `The ${builtImage.name} could not be built: ${lastLine(built.stderr || built.stdout)}`,
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
      if (isCircleContainerKey(storageId)) {
        void this.removeIdle(storageId).catch(() => undefined);
        return;
      }
      void this.options
        .cli()
        .then((cli) => cli?.run(["stop", "-t", String(STOP_TIMEOUT_SECONDS), this.containerName(storageId)]));
    }, this.idleMs);
    timer.unref();
    this.idleTimers.set(storageId, timer);
  }

  /** Removes a circle member's idle container and network, unless a command arrived while waiting for its turn. */
  private async removeIdle(storageId: string): Promise<void> {
    const cli = await this.options.cli();
    if (!cli) return;
    await this.serialized(storageId, async () => {
      if (this.active.has(storageId) || this.disposed) return;
      await cli.run(["rm", "-f", this.containerName(storageId)]);
      await this.removeNetwork(cli, this.networkName(storageId));
    });
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
