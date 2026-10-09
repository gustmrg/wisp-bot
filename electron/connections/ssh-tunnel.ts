import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";

import { FatalTransportError, type RemoteTransport } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { SshQuestions, type SshInteraction } from "./ssh-auth.js";

const READY_TIMEOUT_MS = 20_000;
const PAIR_TIMEOUT_MS = 30_000;
const AUTHORIZE_TIMEOUT_MS = 30_000;
const MAX_STDERR = 8 * 1024;
// A fixed command: the remote shell sees no user input. ~/.local/bin is where
// the server docs install wispctl, and it is often missing from the PATH of
// non-interactive SSH sessions.
const PAIR_COMMAND = 'PATH="$HOME/.local/bin:$PATH" wispctl pair --json';
// Adds the public keys read from stdin to authorized_keys, once each, like
// ssh-copy-id. A fixed command run by sh, whatever the login shell: the keys
// arrive on stdin, already checked to be plain key lines.
export const AUTHORIZE_COMMAND =
  "exec sh -c 'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys || exit 1; " +
  'if [ -s ~/.ssh/authorized_keys ] && [ -n "$(tail -c 1 ~/.ssh/authorized_keys)" ]; then echo >> ~/.ssh/authorized_keys; fi; ' +
  'while IFS= read -r key; do grep -qxF -- "$key" ~/.ssh/authorized_keys || printf "%s\\n" "$key" >> ~/.ssh/authorized_keys || exit 1; done\'';

export interface SshTunnelOptions {
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
  signal?: AbortSignal;
  /** Lets OpenSSH ask the person questions; without it, SSH runs in BatchMode and fails instead. */
  interaction?: SshInteraction;
}

/**
 * Options shared by the tunnel and the commands run over SSH. Host keys are
 * verified by OpenSSH's known_hosts; when Wisp can ask, OpenSSH asks it to
 * trust an unknown host key, and refuses a changed one either way.
 */
export function sshArguments(profile: SshConnectionProfile, interactive = false): string[] {
  return [
    ...(interactive ? [] : ["-o", "BatchMode=yes"]),
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
  const questions = new SshQuestions(options.interaction, ssh, profile, options.signal);
  const child = spawn(
    ssh,
    [
      "-N",
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      ...sshArguments(profile, questions.interactive),
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${profile.serverPort}`,
      "--",
      profile.host,
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, ...(questions.env ? { env: questions.env } : {}) },
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
  void exited.then(() => {
    process.off("exit", stop);
    questions.close();
  });
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
      const expire = (): void => {
        // Time spent answering SSH's questions does not count.
        if (questions.busy(READY_TIMEOUT_MS)) timer = setTimeout(expire, READY_TIMEOUT_MS);
        else finish(new Error(`SSH to ${profile.host} did not connect within ${READY_TIMEOUT_MS / 1000} seconds.`));
      };
      let timer = setTimeout(expire, READY_TIMEOUT_MS);
      void exited.then(() => finish(sshFailure(stderr(), profile, spawnError, questions)));
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
  if (questions.password !== undefined) {
    // The password worked: add this computer's keys, so Wisp connects with them from now on.
    await authorizeKeys(ssh, profile, options.interaction, questions.keys, questions.password, options.signal).catch(
      (error: Error) => options.interaction?.logger?.warn("ssh_key_authorization_failed", { message: error.message }),
    );
    questions.password = undefined;
  }
  let explained = stderr().length;
  return {
    baseUrl: `http://127.0.0.1:${localPort}`,
    closed: exited,
    close: stop,
    requestPairingCode: () => requestPairingCode(ssh, profile, options.interaction),
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
  interaction: SshInteraction | undefined,
): Promise<string> {
  const questions = new SshQuestions(interaction, ssh, profile);
  const child = spawn(ssh, ["-T", ...sshArguments(profile, questions.interactive), "--", profile.host, PAIR_COMMAND], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(questions.env ? { env: questions.env } : {}),
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length < MAX_STDERR) stdout += chunk;
  });
  const stderr = collect(child);
  let timedOut = false;
  const expire = (): void => {
    if (questions.busy(PAIR_TIMEOUT_MS)) {
      timer = setTimeout(expire, PAIR_TIMEOUT_MS);
      return;
    }
    timedOut = true;
    child.kill("SIGTERM");
  };
  let timer = setTimeout(expire, PAIR_TIMEOUT_MS);
  let spawnError: Error | undefined;
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  clearTimeout(timer);
  questions.close();
  if (code === 0) {
    try {
      const value = (JSON.parse(stdout) as { code?: unknown }).code;
      if (typeof value === "string" && value) return value;
    } catch {
      // Reported below.
    }
  }
  throw explainPairingFailure(profile, code, stderr(), timedOut, spawnError, questions);
}

/**
 * Adds this computer's public key to authorized_keys on the server, after
 * the person's password let Wisp in. The password answers this one command
 * and is then forgotten.
 */
export async function authorizeKeys(
  ssh: string,
  profile: SshConnectionProfile,
  interaction: SshInteraction | undefined,
  keys: string[],
  password: string,
  signal?: AbortSignal,
): Promise<void> {
  const questions = new SshQuestions(interaction, ssh, profile, signal, password);
  const child = spawn(
    ssh,
    ["-T", ...sshArguments(profile, questions.interactive), "--", profile.host, AUTHORIZE_COMMAND],
    { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, ...(questions.env ? { env: questions.env } : {}) },
  );
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(keys.map((key) => `${key}\n`).join(""));
  const stderr = collect(child);
  const timer = setTimeout(() => child.kill("SIGTERM"), AUTHORIZE_TIMEOUT_MS);
  let spawnError: Error | undefined;
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  clearTimeout(timer);
  questions.close();
  if (code === 0) return;
  if (spawnError || code === 255) throw sshFailure(stderr(), profile, spawnError, questions);
  const detail = stderr().trim().split("\n").pop();
  throw new Error(`Could not add this computer's SSH key on ${profile.host}${detail ? `: ${detail}` : "."}`);
}

/** Why `wispctl pair` over SSH failed, in terms of what to do on the server. */
export function explainPairingFailure(
  profile: SshConnectionProfile,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnError?: Error,
  questions?: SshQuestions,
): FatalTransportError {
  const { host } = profile;
  const manual = "Or run `wispctl pair` there and enter the code here.";
  if (timedOut) {
    return new FatalTransportError(`${host} did not answer within ${PAIR_TIMEOUT_MS / 1000} seconds. ${manual}`);
  }
  // OpenSSH exits with 255 when the connection itself failed.
  if (spawnError || exitCode === 255) {
    return new FatalTransportError(sshFailure(stderr, profile, spawnError, questions).message);
  }
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

/**
 * Why an ssh process failed: a question the person declined or could not
 * answer, or else what OpenSSH said.
 */
export function sshFailure(
  stderr: string,
  profile: SshConnectionProfile,
  spawnError: Error | undefined,
  questions?: SshQuestions,
): Error {
  const { host } = profile;
  if (questions?.noKey) {
    return new FatalTransportError(
      `${host} asks for a password. Wisp uses a password only to add this computer's SSH key to the server, and this computer has no SSH key yet. Create one with \`ssh-keygen -t ed25519\`, then retry.`,
    );
  }
  if (questions?.declined === "host_key") {
    return new FatalTransportError(`Wisp did not connect to ${host}, because its SSH host key was not trusted.`);
  }
  if (questions?.declined) return new FatalTransportError(`Connecting to ${host} over SSH was cancelled.`);
  return classify(stderr, profile, spawnError, questions);
}

/** Turns what OpenSSH said about a failed connection into what to do about it. */
export function classify(
  stderr: string,
  profile: SshConnectionProfile,
  spawnError: Error | undefined,
  questions?: SshQuestions,
): Error {
  const { host } = profile;
  if ((spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new FatalTransportError("OpenSSH is not installed on this computer. Install the ssh client and retry.");
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(stderr)) {
    return new FatalTransportError(
      `The SSH host key of ${host} has changed. That happens when the server is reinstalled, but can also mean someone is intercepting the connection. If you expected it, run \`ssh-keygen -R ${host}\`, then retry.`,
    );
  }
  if (/Host key verification failed|host key .* not known/i.test(stderr)) {
    return new FatalTransportError(
      `The SSH host key of ${host} is not trusted yet. Run \`ssh ${host}\` in a terminal to verify it, then retry.`,
    );
  }
  if (/login\.tailscale\.com|tailscale.*(check|approval)/i.test(stderr)) {
    return new FatalTransportError(
      `Tailscale SSH asks for a browser check. Run \`ssh ${host}\` in a terminal to approve it, then retry.`,
    );
  }
  if (/Permission denied/i.test(stderr)) return new FatalTransportError(explainDenied(stderr, profile, questions));
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

/**
 * Why the server turned this computer away. OpenSSH names the user it tried,
 * which may come from ~/.ssh/config, and the methods the server accepts.
 */
function explainDenied(stderr: string, profile: SshConnectionProfile, questions?: SshQuestions): string {
  const match = /(?:(\S+)@\S+: )?Permission denied \(([^)]*)\)/i.exec(stderr);
  const user = match?.[1] ?? profile.user;
  const target = user ? `${user}@${profile.host}` : profile.host;
  if (questions?.passwordTried) return `${target} did not accept the password. Retry to enter it again.`;
  const methods = (match?.[2] ?? "").split(",");
  const password = methods.includes("password") || methods.includes("keyboard-interactive");
  const port = profile.sshPort ? `-p ${profile.sshPort} ` : "";
  return [
    `${target} did not accept an SSH key from this computer.`,
    ...(password && !questions?.interactive
      ? ["Your terminal may ask for a password, but Wisp cannot ask here, so it can only use SSH keys."]
      : []),
    `Add this computer's public key to ~/.ssh/authorized_keys${user ? ` for ${user}` : ""} on ${profile.host} (for example with \`ssh-copy-id ${port}${target}\`), then retry.`,
    `To test the way Wisp connects, run \`ssh -o BatchMode=yes ${port}${target} true\`.`,
  ].join(" ");
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
