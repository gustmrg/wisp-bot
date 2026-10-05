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
  signal?: AbortSignal;
}

/** Options shared by the tunnel and the pairing command. Host keys are verified by OpenSSH's known_hosts. */
export function sshArguments(profile: SshConnectionProfile): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
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
      ...sshArguments(profile),
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
  return {
    baseUrl: `http://127.0.0.1:${localPort}`,
    closed: exited,
    close: stop,
    requestPairingCode: () => requestPairingCode(ssh, profile),
  };
}

/** Runs `wispctl pair` on the server over SSH, so pairing needs no code typed by hand. */
async function requestPairingCode(ssh: string, profile: SshConnectionProfile): Promise<string> {
  const child = spawn(ssh, ["-T", ...sshArguments(profile), "--", profile.host, PAIR_COMMAND], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < MAX_STDERR) stdout += chunk;
  });
  const stderr = collect(child);
  const timer = setTimeout(() => child.kill("SIGTERM"), PAIR_TIMEOUT_MS);
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", () => resolve(null));
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
  const detail = stderr().trim().split("\n").pop();
  throw new FatalTransportError(
    `Could not get a pairing code from ${profile.host}: run \`wispctl pair\` there and enter the code here.${
      detail ? ` (${detail})` : ""
    }`,
  );
}

function classify(stderr: string, host: string, spawnError: Error | undefined): Error {
  if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new FatalTransportError("OpenSSH is not installed on this computer. Install the ssh client and retry.");
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* not known/i.test(stderr)) {
    return new FatalTransportError(
      `The SSH host key of ${host} is not trusted yet or has changed. Run \`ssh ${host}\` in a terminal to verify it, then retry.`,
    );
  }
  if (/login\.tailscale\.com|tailscale.*(check|approval)/i.test(stderr)) {
    return new FatalTransportError(
      `Tailscale SSH asks for a browser check. Run \`ssh ${host}\` in a terminal to approve it, then retry.`,
    );
  }
  if (/Permission denied/i.test(stderr)) {
    return new FatalTransportError(
      `${host} rejected this computer's SSH key. Load the key into ssh-agent or set it in ~/.ssh/config, then retry.`,
    );
  }
  if (/Could not resolve hostname/i.test(stderr)) return new Error(`The host name ${host} could not be resolved.`);
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
