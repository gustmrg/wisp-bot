import { spawn } from "node:child_process";

import type { ContainerRuntimeStatus } from "../shared/execution.js";

export type ContainerRuntimeName = "docker" | "podman";

export interface ContainerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ContainerProcess {
  /** Resolves with the exit code, or null when the program was killed. */
  done: Promise<number | null>;
  kill(): void;
}

/**
 * The container program, run without a shell: every value is one argument,
 * so nothing in it can become another command.
 */
export interface ContainerCli {
  readonly name: ContainerRuntimeName;
  run(
    args: ReadonlyArray<string>,
    options?: { input?: string; env?: Record<string, string> },
  ): Promise<ContainerCommandResult>;
  stream(
    args: ReadonlyArray<string>,
    options: { onData: (data: Buffer) => void; env?: Record<string, string> },
  ): ContainerProcess;
}

/** Most output kept from a command whose output is read rather than streamed. */
const MAX_CAPTURED_BYTES = 1_000_000;
/**
 * What the container program needs from this process's environment to find its
 * service. Nothing else is passed, and values reach a container only when a
 * command names them with `-e`.
 */
const FORWARDED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "CONTAINER_HOST",
  "CONTAINERS_CONF",
];

/** Where Docker Desktop, Homebrew and system packages install the programs, for apps started without a login shell's PATH. */
const COMMON_PROGRAM_DIRECTORIES = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

function programEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of FORWARDED_ENVIRONMENT) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const path = (env.PATH ?? "").split(":").filter(Boolean);
  env.PATH = [...path, ...COMMON_PROGRAM_DIRECTORIES.filter((directory) => !path.includes(directory))].join(":");
  return { ...env, ...extra };
}

export class SpawnedContainerCli implements ContainerCli {
  constructor(
    readonly name: ContainerRuntimeName,
    private readonly program: string = name,
  ) {}

  run(
    args: ReadonlyArray<string>,
    options: { input?: string; env?: Record<string, string> } = {},
  ): Promise<ContainerCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(this.program, [...args], {
        env: programEnvironment(options.env),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        if (size >= MAX_CAPTURED_BYTES) return;
        size += chunk.byteLength;
        into.push(chunk);
      };
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      if (options.input !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(options.input);
      }
      child.once("error", (error) =>
        resolve({ exitCode: 127, stdout: "", stderr: (error as NodeJS.ErrnoException).code ?? "spawn failed" }),
      );
      child.once("close", (code) =>
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  }

  stream(
    args: ReadonlyArray<string>,
    options: { onData: (data: Buffer) => void; env?: Record<string, string> },
  ): ContainerProcess {
    const child = spawn(this.program, [...args], {
      env: programEnvironment(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    const done = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(127));
      child.once("close", (code) => resolve(code));
    });
    return {
      done,
      kill: () => {
        child.kill("SIGKILL");
      },
    };
  }
}

const RUNTIME_CACHE_MS = 60_000;

/**
 * Finds Docker or Podman, preferring Docker. The answer is cached for a
 * minute, so installing or starting one is noticed without a restart.
 */
export class ContainerRuntimeDetector {
  private cached:
    | { at: number; result: Promise<{ status: ContainerRuntimeStatus; cli: ContainerCli | null }> }
    | undefined;

  constructor(
    private readonly candidates: ReadonlyArray<ContainerCli> = [
      new SpawnedContainerCli("docker"),
      new SpawnedContainerCli("podman"),
    ],
    private readonly now: () => number = Date.now,
  ) {}

  async status(): Promise<ContainerRuntimeStatus> {
    return (await this.detect()).status;
  }

  async cli(): Promise<ContainerCli | null> {
    return (await this.detect()).cli;
  }

  private detect(): Promise<{ status: ContainerRuntimeStatus; cli: ContainerCli | null }> {
    const now = this.now();
    if (!this.cached || now - this.cached.at >= RUNTIME_CACHE_MS) {
      this.cached = { at: now, result: this.probe() };
    }
    return this.cached.result;
  }

  private async probe(): Promise<{ status: ContainerRuntimeStatus; cli: ContainerCli | null }> {
    let unreachable: string | undefined;
    for (const cli of this.candidates) {
      const format = cli.name === "docker" ? "{{.Server.Version}}" : "{{.Version}}";
      const result = await cli.run(["version", "--format", format]);
      const version = result.stdout.trim();
      if (result.exitCode === 0 && version) {
        return { status: { available: true, name: cli.name, version: version.slice(0, 40) }, cli };
      }
      // 127: the program is not installed. Anything else: installed, but its service did not answer.
      if (result.exitCode !== 127) unreachable ??= cli.name === "docker" ? "Docker" : "Podman";
    }
    return {
      status: {
        available: false,
        message: unreachable
          ? `${unreachable} is installed on the server, but its service is not reachable. Start it, then try again.`
          : "Install Docker or Podman on the server to run commands in containers.",
      },
      cli: null,
    };
  }
}
