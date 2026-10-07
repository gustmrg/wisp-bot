import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FatalTransportError } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { WISP_SERVER_PACKAGE } from "../../shared/server-package.js";
import type { WispSshKey } from "./ssh-key.js";
import { classify, sshArguments } from "./ssh-tunnel.js";

const MAX_OUTPUT = 16 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;

/**
 * Prints the version of the server the setup installed, or "none". Scripts
 * run by `sh` from stdin, whatever the login shell is, and see no user input.
 */
export const PROBE_COMMAND = `f="$HOME/.local/lib/wisp-server/node_modules/${WISP_SERVER_PACKAGE}/package.json"; if [ -f "$f" ]; then v=$(sed -n 's/^ *"version": *"\\([^"]*\\)".*/\\1/p' "$f" | head -n 1); echo "wisp-server \${v:-unknown}"; else echo "wisp-server none"; fi`;

// What a public key line from WispSshKey looks like; nothing else reaches the remote shell.
const PUBLIC_KEY_LINE = /^ssh-ed25519 [A-Za-z0-9+/=]+ [A-Za-z0-9._@-]+$/;

/**
 * Appends Wisp's key to the server's authorized_keys, once. `restrict` turns
 * off terminals and agent forwarding for it; `port-forwarding` keeps the
 * tunnel to the Wisp server working.
 */
export function authorizeKeyCommand(publicKey: string): string {
  if (!PUBLIC_KEY_LINE.test(publicKey)) throw new FatalTransportError("Wisp's SSH key is invalid.");
  const blob = publicKey.split(" ")[1]!;
  const line = `restrict,port-forwarding ${publicKey}`;
  return `umask 077 && mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && { grep -qF '${blob}' "$HOME/.ssh/authorized_keys" || printf '%s\\n' '${line}' >> "$HOME/.ssh/authorized_keys"; }`;
}

export interface SshCheckOptions {
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
  /** Makes OpenSSH ask its questions in the app; see AskpassBroker. */
  askpassEnv: Record<string, string>;
  key: WispSshKey;
  /** Names this computer in the comment of Wisp's key. */
  deviceName: string;
  /** Tailscale SSH waits until the person approves the connection on this page. */
  onBrowserCheck?: (url: string) => void;
  signal?: AbortSignal;
}

export interface SshCheckResult {
  installedVersion?: string;
  addedKey: boolean;
}

/**
 * Connects to an SSH server the way a terminal would, asking in the app
 * about an unknown host key or a password, then makes sure Wisp can connect
 * again without asking. When only a password works, it adds Wisp's own key
 * to the server. Also reports which Wisp server version is installed there.
 *
 * One connection, the control master, carries every question; the later
 * commands reuse it, so a password is asked at most once.
 */
export async function checkSshServer(profile: SshConnectionProfile, options: SshCheckOptions): Promise<SshCheckResult> {
  const ssh = options.sshPath ?? "ssh";
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-ssh-"));
  const control = path.join(directory, "c");
  const identityFile = options.key.identityFile;
  const viaMaster = ["-S", control, ...sshArguments(profile, { identityFile })];
  const master = spawn(
    ssh,
    [
      "-M",
      "-N",
      "-T",
      "-S",
      control,
      ...sshArguments(profile, { interactive: true, identityFile }),
      "--",
      profile.host,
    ],
    {
      env: { ...process.env, ...options.askpassEnv },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let masterError = "";
  master.stderr?.setEncoding("utf8");
  let browserUrl: string | undefined;
  master.stderr?.on("data", (chunk: string) => {
    masterError = (masterError + chunk).slice(-MAX_OUTPUT);
    const url = browserCheckUrl(masterError);
    if (url && url !== browserUrl) {
      browserUrl = url;
      options.onBrowserCheck?.(url);
    }
  });
  let spawnError: Error | undefined;
  let masterExited = false;
  const exited = new Promise<void>((resolve) => {
    master.once("exit", () => resolve());
    master.once("error", (error) => {
      spawnError = error;
      resolve();
    });
  }).then(() => {
    masterExited = true;
  });
  const stop = (): void => {
    if (master.exitCode === null && master.signalCode === null) master.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const cancelled = (): FatalTransportError => new FatalTransportError("Checking the connection was cancelled.");
  try {
    // Signed in once the master answers; it exits when a question was refused or the login failed.
    while (!(await run(ssh, [...viaMaster, "-O", "check", "--", profile.host])).ok) {
      if (options.signal?.aborted) throw cancelled();
      if (masterExited) {
        throw new FatalTransportError(
          /Permission denied/i.test(masterError) && /password|keyboard-interactive/i.test(masterError)
            ? `${profile.host} did not accept the password.`
            : classify(masterError, profile.host, spawnError).message,
        );
      }
      await sleep(READY_POLL_MS);
    }
    const probe = await run(ssh, ["-T", ...viaMaster, "--", profile.host, "sh -s"], PROBE_COMMAND);
    if (options.signal?.aborted) throw cancelled();
    if (!probe.ok) throw new FatalTransportError(`Could not check ${profile.host}: ${lastLine(probe.stderr)}`);
    const version = /^wisp-server (\S+)$/m.exec(probe.stdout)?.[1];
    const installedVersion = version && version !== "none" ? version : undefined;

    // Wisp reconnects in the background, where nobody can answer a question.
    let addedKey = false;
    let batch = await run(ssh, batchArguments(profile, options.key.identityFile));
    if (!batch.ok && /Permission denied/i.test(batch.stderr)) {
      const publicKey = await options.key.publicKey(options.deviceName);
      const authorized = await run(
        ssh,
        ["-T", ...viaMaster, "--", profile.host, "sh -s"],
        authorizeKeyCommand(publicKey),
      );
      if (!authorized.ok) {
        throw new FatalTransportError(
          `Could not add Wisp's key to ${profile.host}: ${lastLine(authorized.stderr) || "the command failed"}.`,
        );
      }
      addedKey = true;
      batch = await run(ssh, batchArguments(profile, options.key.identityFile));
    }
    if (options.signal?.aborted) throw cancelled();
    if (!batch.ok) {
      throw new FatalTransportError(
        /Permission denied/i.test(batch.stderr)
          ? `${profile.host} does not accept SSH keys, so Wisp would need the password every time. Allow public key login there (PubkeyAuthentication yes).`
          : classify(batch.stderr, profile.host, undefined).message,
      );
    }
    return { ...(installedVersion ? { installedVersion } : {}), addedKey };
  } finally {
    options.signal?.removeEventListener("abort", stop);
    if (!masterExited) await run(ssh, [...viaMaster, "-O", "exit", "--", profile.host]);
    stop();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}

/** The page Tailscale SSH asks to visit before it lets a connection in ("check" mode). */
export function browserCheckUrl(stderr: string): string | undefined {
  const url = /To authenticate, visit:\s*(https:\/\/[^\s"'<>]+)/i.exec(stderr)?.[1];
  return url && url.length <= 512 ? url : undefined;
}

/** A fresh connection that may not ask anything, like the ones Wisp makes later. */
function batchArguments(profile: SshConnectionProfile, identityFile: string | undefined): string[] {
  return [
    "-T",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    ...sshArguments(profile, { identityFile }),
    "--",
    profile.host,
    "true",
  ];
}

/** Runs ssh to completion, with a script for `sh -s`, or other input, on stdin. */
export function run(
  ssh: string,
  args: string[],
  script?: string,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ssh, args, { stdio: [script ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(script ? `${script}\n` : undefined);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_OUTPUT);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
