import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { createInterface } from "node:readline";

import type { StructuredLogger } from "../../backend/structured-logger.js";

const START_TIMEOUT_MS = 30_000;
// The server gives agents ten seconds to settle before it exits.
const STOP_TIMEOUT_MS = 12_000;
const KILL_TIMEOUT_MS = 2_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** A Wisp server on this computer, reached like any other server. */
export interface LocalServer {
  /** Starts the server unless it is running, and resolves with how to reach and pair with it. */
  ensureRunning(): Promise<RunningLocalServer>;
  /** Lets running Wisps settle, then stops the server. */
  stop(): Promise<void>;
}

export interface RunningLocalServer {
  baseUrl: string;
  /** Pairs this app as the server's local device; valid once, for this server process. */
  localPairingCode: string;
  /** Resolves when the server process exits. */
  exited: Promise<void>;
}

export interface ChildProcessLocalServerOptions {
  /** The compiled `server/main.js`. */
  scriptPath: string;
  /** The app's data directory; the backend's stores live in its `backend/` folder. */
  dataDirectory: string;
  agentMode: "pi" | "fake";
  /** The credential key, kept by the app in the system keychain; without it credentials cannot be saved. */
  masterKey?: Buffer;
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

  constructor(private readonly options: ChildProcessLocalServerOptions) {}

  ensureRunning(): Promise<RunningLocalServer> {
    if (this.running && this.running.child.exitCode === null && this.running.child.signalCode === null) {
      return this.running.ready;
    }
    const { options } = this;
    const child = spawn(
      options.execPath ?? process.execPath,
      [
        options.scriptPath,
        "--data-dir",
        options.dataDirectory,
        "--port",
        "0",
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
        let event: { event?: string; port?: number } | undefined;
        try {
          event = JSON.parse(line) as { event?: string; port?: number };
        } catch {
          return;
        }
        if (event?.event === "server_started" && typeof event.port === "number") {
          clearTimeout(timer);
          resolve({ baseUrl: `http://127.0.0.1:${event.port}`, localPairingCode, exited });
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
      if (child.exitCode !== 0)
        options.logger.warn("local_server_exited", { code: child.exitCode, signal: child.signalCode });
    });
    this.running = { child, ready };
    return ready;
  }

  async stop(): Promise<void> {
    const running = this.running;
    this.running = undefined;
    if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
    const { child } = running;
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
