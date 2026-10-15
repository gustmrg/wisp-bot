import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { createInterface } from "node:readline";

import type { StructuredLogger } from "../../backend/structured-logger.js";
import type { AdminCommand } from "../../server/admin.js";

const START_TIMEOUT_MS = 30_000;
// The server gives agents ten seconds to settle before it exits.
const STOP_TIMEOUT_MS = 12_000;
const KILL_TIMEOUT_MS = 2_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const ADMIN_TIMEOUT_MS = 30_000;

/**
 * How other devices reach the server while remote access to this computer is
 * on: it still listens on loopback only, on a fixed port a private HTTPS proxy
 * such as Tailscale Serve forwards to, and serves the browser app.
 */
export interface LocalServerExposure {
  port: number;
  /** The exact HTTPS origin the proxy serves, such as https://laptop.tailnet.ts.net. */
  publicOrigin: string;
}

/** A Wisp server on this computer, reached like any other server. */
export interface LocalServer {
  /** Starts the server unless it is running, and resolves with how to reach and pair with it. */
  ensureRunning(): Promise<RunningLocalServer>;
  /** Lets running Wisps settle, then stops the server. */
  stop(): Promise<void>;
  /** How the next start exposes the server; a running server keeps its own until it restarts. */
  setExposure(exposure: LocalServerExposure | undefined): void;
  /** Runs an administrative command, such as `pair`, `devices`, or `revoke`, on the running server. */
  admin(command: AdminCommand): Promise<unknown>;
}

export interface RunningLocalServer {
  baseUrl: string;
  /** Pairs this app as the server's local device; valid once, for this server process. */
  localPairingCode: string;
  /** Resolves when the server process exits. */
  exited: Promise<void>;
  /** Set when the server started exposed for remote access. */
  exposure?: LocalServerExposure;
}

export interface ChildProcessLocalServerOptions {
  /** The compiled `server/main.js`. */
  scriptPath: string;
  /** The app's data directory; the backend's stores live in its `backend/` folder. */
  dataDirectory: string;
  agentMode: "pi" | "fake";
  /** The credential key, kept by the app in the system keychain; without it credentials cannot be saved. */
  masterKey?: Buffer;
  /** The browser app's built files, served to other devices while the server is exposed. */
  webRoot?: string;
  logger: Pick<StructuredLogger, "info" | "warn">;
  /** Electron's executable, run as Node. */
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs `server/main.js` as a child process with Electron's own Node, the way
 * a remote server runs it. The master key and a pairing code travel on stdin,
 * which stays open: when this app exits, even abnormally, stdin closes and
 * the server shuts down.
 */
export class ChildProcessLocalServer implements LocalServer {
  private running: { child: ChildProcessWithoutNullStreams; ready: Promise<RunningLocalServer> } | undefined;
  /** A stop in progress; a start waits for it, since both servers would want the same data directory. */
  private stopping: Promise<void> | undefined;
  private exposure: LocalServerExposure | undefined;
  private adminRequests = 0;
  private readonly pendingAdmin = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly options: ChildProcessLocalServerOptions) {}

  setExposure(exposure: LocalServerExposure | undefined): void {
    this.exposure = exposure;
  }

  ensureRunning(): Promise<RunningLocalServer> {
    if (this.stopping) return this.stopping.then(() => this.ensureRunning());
    if (this.running && this.running.child.exitCode === null && this.running.child.signalCode === null) {
      return this.running.ready;
    }
    const { options } = this;
    const exposure = this.exposure;
    const child = spawn(
      options.execPath ?? process.execPath,
      [
        options.scriptPath,
        "--data-dir",
        options.dataDirectory,
        "--port",
        String(exposure?.port ?? 0),
        ...(exposure ? ["--public-origin", exposure.publicOrigin] : []),
        ...(exposure && options.webRoot ? ["--web-root", options.webRoot] : []),
        "--agent-mode",
        options.agentMode,
        "--bootstrap-stdin",
      ],
      {
        env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    process.once("exit", kill);
    void exited.then(() => process.off("exit", kill));

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const localPairingCode = Array.from({ length: 26 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    child.stdin.on("error", () => undefined);
    child.stdin.write(
      `${JSON.stringify({ localPairingCode, ...(options.masterKey ? { masterKey: options.masterKey.toString("base64") } : {}) })}\n`,
    );

    const ready = new Promise<RunningLocalServer>((resolve, reject) => {
      const timer = setTimeout(() => {
        kill();
        reject(new Error("Wisps on this computer took too long to start."));
      }, START_TIMEOUT_MS);
      const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      lines.on("line", (line) => {
        let event: AdminResponse & { event?: string; port?: number };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          return;
        }
        if (event?.event === "admin_response") {
          this.settleAdmin(event);
          return;
        }
        if (event?.event === "server_started" && typeof event.port === "number") {
          clearTimeout(timer);
          resolve({
            baseUrl: `http://127.0.0.1:${event.port}`,
            localPairingCode,
            exited,
            ...(exposure ? { exposure } : {}),
          });
        }
      });
      void exited.then(() => {
        clearTimeout(timer);
        const reason = stderr
          .trim()
          .split("\n")
          .pop()
          ?.replace(/^Wisp server could not start: /, "");
        reject(
          new Error(reason ? `Wisps on this computer could not start: ${reason}` : "Wisps on this computer stopped."),
        );
      });
    });
    void exited.then(() => {
      for (const [id, pending] of this.pendingAdmin) {
        this.pendingAdmin.delete(id);
        pending.reject(new Error("Wisps on this computer stopped."));
      }
      if (child.exitCode !== 0)
        options.logger.warn("local_server_exited", { code: child.exitCode, signal: child.signalCode });
    });
    this.running = { child, ready };
    return ready;
  }

  async admin(command: AdminCommand): Promise<unknown> {
    const running = this.running;
    if (!running) throw new Error("Wisps on this computer are not running.");
    await running.ready;
    const id = ++this.adminRequests;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAdmin.delete(id);
        reject(new Error("Wisps on this computer did not answer."));
      }, ADMIN_TIMEOUT_MS);
      this.pendingAdmin.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      running.child.stdin.write(`${JSON.stringify({ id, command })}\n`);
    });
  }

  private settleAdmin(response: AdminResponse): void {
    const pending = typeof response.id === "number" ? this.pendingAdmin.get(response.id) : undefined;
    if (!pending) return;
    this.pendingAdmin.delete(response.id as number);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(typeof response.error === "string" ? response.error : "The command failed."));
  }

  async stop(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
    const stopping = this.stopChild(running.child);
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Closing stdin asks the server to shut down cleanly.
    child.stdin.end();
    if (await settles(exited, STOP_TIMEOUT_MS)) return;
    child.kill("SIGTERM");
    if (await settles(exited, KILL_TIMEOUT_MS)) return;
    child.kill("SIGKILL");
    await exited;
  }
}

/** An answer to an administrative command, on its own stdout line. */
interface AdminResponse {
  id?: unknown;
  ok?: boolean;
  value?: unknown;
  error?: unknown;
}

async function settles(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
