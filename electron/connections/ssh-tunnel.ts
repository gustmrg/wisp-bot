import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";

import { FatalTransportError, type RemoteTransport } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";

const READY_TIMEOUT_MS = 20_000;
const PAIR_TIMEOUT_MS = 30_000;
const MAX_STDERR = 8 * 1024;
// A fixed command: the remote shell sees no user input. ~/.local/bin is where
// the server docs install wispctl, and it is often missing from the PATH of
// non-interactive SSH sessions.
const PAIR_COMMAND = 'PATH="$HOME/.local/bin:$PATH" wispctl pair --json';

export interface SshTunnelOptions {
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
  /** Wisp's own key, once it added one to a server that only accepted a password. */
  identityFile?: string;
  signal?: AbortSignal;
}

export interface SshArgumentOptions {
  /** Let OpenSSH ask for host keys and passwords, through SSH_ASKPASS. */
  interactive?: boolean;
  identityFile?: string;
}

/**
 * Options shared by every ssh Wisp runs. Host keys are verified by OpenSSH's
 * known_hosts. Only a check the person started may ask questions; everything
 * else runs in batch mode and fails rather than waiting for an answer.
 */
export function sshArguments(profile: SshConnectionProfile, options: SshArgumentOptions = {}): string[] {
  return [
    "-o",
    `BatchMode=${options.interactive ? "no" : "yes"}`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(options.identityFile ? ["-i", options.identityFile] : []),
    ...(profile.sshPort ? ["-p", String(profile.sshPort)] : []),
    ...(profile.user ? ["-l", profile.user] : []),
  ];
}

/**
 * Forwards a free loopback port to the server's loopback port with OpenSSH,
 * using the user's own SSH configuration, agent, and known hosts. The app
 * never stores SSH keys or passwords.
 */
export async function openSshTunnel(
  profile: SshConnectionProfile,
  options: SshTunnelOptions = {},
): Promise<RemoteTransport> {
  const ssh = options.sshPath ?? "ssh";
  const localPort = await freePort();
  const child = spawn(
    ssh,
    [
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      ...sshArguments(profile, { identityFile: options.identityFile }),
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${profile.serverPort}`,
      "--",
      profile.host,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  const stderr = collect(child);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const stop = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  // A tunnel must not outlive the app, even when it exits without cleaning up.
  process.once("exit", stop);
  void exited.then(() => process.off("exit", stop));
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`SSH to ${profile.host} did not connect within ${READY_TIMEOUT_MS / 1000} seconds.`)),
        READY_TIMEOUT_MS,
      );
      void exited.then(() => finish(classify(stderr(), profile.host, spawnError)));
      waitForPort(localPort, () => settled || Boolean(options.signal?.aborted)).then(
        (ready) => finish(ready ? undefined : new Error("Connecting was cancelled.")),
        finish,
      );
    });
  } catch (error) {
    stop();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
  }
  let explained = stderr().length;
  return {
    baseUrl: `http://127.0.0.1:${localPort}`,
    closed: exited,
    close: stop,
    requestPairingCode: () => requestPairingCode(ssh, profile, options.identityFile),
    explainFailure: () => {
      // Only what OpenSSH reported since the last failure explains this one.
      const recent = stderr().slice(explained);
      explained = stderr().length;
      return /open failed: connect failed/i.test(recent)
        ? `SSH to ${profile.host} works, but nothing answers on its port ${profile.serverPort}. Start the Wisp server there (for example \`systemctl --user start wisp\`) or check the server port of this connection.`
        : undefined;
    },
  };
}

/** Runs `wispctl pair` on the server over SSH, so pairing needs no code typed by hand. */
async function requestPairingCode(
  ssh: string,
  profile: SshConnectionProfile,
  identityFile: string | undefined,
): Promise<string> {
  const child = spawn(ssh, ["-T", ...sshArguments(profile, { identityFile }), "--", profile.host, PAIR_COMMAND], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < MAX_STDERR) stdout += chunk;
  });
  const stderr = collect(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, PAIR_TIMEOUT_MS);
  let spawnError: Error | undefined;
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  clearTimeout(timer);
  if (code === 0) {
    try {
      const value = (JSON.parse(stdout) as { code?: unknown }).code;
      if (typeof value === "string" && value) return value;
    } catch {
      // Reported below.
    }
  }
  throw explainPairingFailure(profile.host, code, stderr(), timedOut, spawnError);
}

/** Why `wispctl pair` over SSH failed, in terms of what to do on the server. */
export function explainPairingFailure(
  host: string,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnError?: Error,
): FatalTransportError {
  const manual = "Or run `wispctl pair` there and enter the code here.";
  if (timedOut) {
    return new FatalTransportError(`${host} did not answer within ${PAIR_TIMEOUT_MS / 1000} seconds. ${manual}`);
  }
  // OpenSSH exits with 255 when the connection itself failed.
  if (spawnError || exitCode === 255) return new FatalTransportError(classify(stderr, host, spawnError).message);
  if (/No Wisp server is running/i.test(stderr)) {
    return new FatalTransportError(
      `The Wisp server is not running on ${host}. Start it there (for example \`systemctl --user start wisp\`), then retry.`,
    );
  }
  if (
    /wispctl: (command )?not found|wispctl: No such file/i.test(stderr) ||
    (exitCode === 127 && !/node/i.test(stderr))
  ) {
    return new FatalTransportError(
      `wispctl is not installed on ${host}, or not in ~/.local/bin. Choose “Install the Wisp server” to set it up, or run \`npx @gustmrg/wisp-server setup\` there. ${manual}`,
    );
  }
  if (/node: (command )?not found|env: .?node.?: No such file/i.test(stderr)) {
    return new FatalTransportError(
      `Node.js is missing on ${host}, or not in the PATH of SSH commands. Install Node.js 22.19 or later there, then retry.`,
    );
  }
  if (/Cannot find module/i.test(stderr)) {
    return new FatalTransportError(
      `The Wisp server files are missing on ${host}. Choose “Install the Wisp server” to set it up again, or run \`npx @gustmrg/wisp-server setup\` there.`,
    );
  }
  const detail = stderr.trim().split("\n").pop();
  return new FatalTransportError(`Could not get a pairing code from ${host}. ${manual}${detail ? ` (${detail})` : ""}`);
}

/** Turns what OpenSSH said about a failed connection into what to do about it. */
export function classify(stderr: string, host: string, spawnError: Error | undefined): Error {
  if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new FatalTransportError("OpenSSH is not installed on this computer. Install the ssh client and retry.");
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(stderr)) {
    // OpenSSH suggests the exact command, with the right file and port.
    const removal = /^\s*(ssh-keygen -f .+ -R .+?)\s*$/m.exec(stderr)?.[1] ?? `ssh-keygen -R ${host}`;
    return new FatalTransportError(
      `The SSH host key of ${host} has changed. If the machine was reinstalled, remove its old key with \`${removal}\`, then retry. Otherwise someone may be intercepting the connection.`,
    );
  }
  if (/Host key verification failed|host key .* not known/i.test(stderr)) {
    return new FatalTransportError(`The SSH host key of ${host} is not trusted yet. Retry to check it and trust it.`);
  }
  if (/login\.tailscale\.com|tailscale.*(check|approval)/i.test(stderr)) {
    return new FatalTransportError(
      `Tailscale SSH asks for a browser check. Run \`ssh ${host}\` in a terminal to approve it, then retry.`,
    );
  }
  if (/Permission denied/i.test(stderr)) {
    return new FatalTransportError(
      `${host} rejected this computer's SSH keys. Retry to sign in with its password, or load your key into ssh-agent.`,
    );
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return new Error(
      `The host name ${host} could not be resolved. Check the spelling, or that this computer is on the tailnet.`,
    );
  }
  if (/Connection refused/i.test(stderr)) {
    return new Error(`${host} refused the SSH connection. Check that SSH runs there and that the SSH port is right.`);
  }
  if (/timed out|No route to host|Network is unreachable/i.test(stderr)) {
    return new Error(`${host} cannot be reached over SSH. Check that it is on and on this network or tailnet.`);
  }
  const last = stderr.trim().split("\n").pop();
  return new Error(last ? `SSH to ${host} failed: ${last}` : `SSH to ${host} exited unexpectedly.`);
}

function collect(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-MAX_STDERR);
  });
  return () => text;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === "object" ? resolve(address.port) : reject(new Error("No port.")),
      );
    });
  });
}

/** Polls until the forwarded port accepts connections; resolves false once `stopped` says so. */
async function waitForPort(port: number, stopped: () => boolean): Promise<boolean> {
  while (!stopped()) {
    if (await canConnect(port)) return true;
    await sleep(100);
  }
  return false;
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
