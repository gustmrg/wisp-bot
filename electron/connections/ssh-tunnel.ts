import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { createTunnelFetch } from "./tunnel-fetch.js";
import { validateConnectionProfile } from "./profile-store.js";

export type SshFailureCode =
  | "missing_client"
  | "host_unknown"
  | "host_changed"
  | "authentication"
  | "network"
  | "backend_unavailable";
export class SshConnectionError extends Error {
  constructor(
    public readonly code: SshFailureCode,
    message: string,
    public readonly fingerprint?: string,
  ) {
    super(message);
    this.name = "SshConnectionError";
  }
}
export interface SshChallenge {
  fingerprint: string;
  knownHostLine: string;
  host: string;
  port: number;
}
export interface SshTunnel {
  endpoint: string;
  hostHeader: string;
  close(): void;
  onClose(listener: () => void): () => void;
  pair(): Promise<string>;
}
const SSH_LIMIT = 64 * 1024;
export function tailscaleAuthenticationUrl(output: string): string | undefined {
  const matches = output.match(/https:\/\/[^\s<>"']+/g) ?? [];
  for (const candidate of matches) {
    try {
      const url = new URL(candidate.replace(/[).,;]+$/, ""));
      if (
        url.protocol === "https:" &&
        url.hostname === "login.tailscale.com" &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === "443")
      )
        return url.href;
    } catch {
      /* Ignore text that is not a URL. */
    }
  }
  return undefined;
}
export function classifySshFailure(stderr: string): SshConnectionError {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key|host key has changed/i.test(stderr))
    return new SshConnectionError(
      "host_changed",
      "The SSH host key changed. Verify the server with its administrator before updating known_hosts.",
    );
  if (/No .* host key is known|Host key verification failed|authenticity of host/i.test(stderr))
    return new SshConnectionError("host_unknown", "Verify this server's SSH fingerprint before connecting.");
  if (/Permission denied|no supported authentication|sign_and_send_pubkey|agent refused|passphrase/i.test(stderr))
    return new SshConnectionError(
      "authentication",
      "SSH authentication was denied. Unlock your key with ssh-add, or check the Tailscale SSH policy.",
    );
  return new SshConnectionError(
    "network",
    "SSH could not reach the server. Check its address, your network/Tailscale connection and forwarding permissions.",
  );
}
/** No shell is used locally. The only remote command is the fixed wispctl invocation. */
export function buildSshArguments(
  profileInput: SshConnectionProfile,
  knownHostsFile: string,
  localPort?: number,
  pairing = false,
): string[] {
  const profile = validateConnectionProfile(profileInput) as SshConnectionProfile;
  if (localPort !== undefined && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535))
    throw new Error("Invalid local SSH port.");
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    `UserKnownHostsFile=${quoteSshConfigPath(knownHostsFile)} ${quoteSshConfigPath(path.join(homedir(), ".ssh", "known_hosts"))}`,
    "-p",
    String(profile.port),
  ];
  if (profile.username) args.push("-l", profile.username);
  if (profile.identityFile && profile.sshAuthMode === "openssh") args.push("-i", profile.identityFile);
  if (localPort !== undefined) args.push("-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`);
  args.push("--", profile.host);
  if (pairing) args.push("wispctl pair --json");
  return args;
}
function quoteSshConfigPath(value: string): string {
  if (/[\r\n\0"%]/.test(value)) throw new Error("Unsupported SSH configuration path.");
  return `"${value.replaceAll("\\", "/")}"`;
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local SSH port.");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
function run(
  command: string,
  args: string[],
  timeoutMs = 20000,
  options: { signal?: AbortSignal; onStderr?: (text: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("The SSH operation was cancelled."));
      return;
    }
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: "pipe" });
    const abort = (): void => {
      child.kill();
      reject(new Error("The SSH operation was cancelled."));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new SshConnectionError("network", "The SSH operation timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > SSH_LIMIT) {
        child.kill();
        reject(new Error("SSH output exceeded its limit."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-SSH_LIMIT);
      options.onStderr?.(stderr);
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new SshConnectionError("missing_client", "Install the operating system OpenSSH client and restart Wisp."));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout);
      else reject(classifySshFailure(stderr));
    });
    child.stdin.end();
  });
}
export class OpenSshTransport {
  private readonly knownHostsFile: string;
  private readonly challenges = new Map<string, SshChallenge>();
  constructor(directory: string) {
    this.knownHostsFile = path.join(directory, "known_hosts");
  }
  async inspectHost(profile: SshConnectionProfile): Promise<SshChallenge> {
    validateConnectionProfile(profile);
    const config = await run("ssh", [
      "-G",
      ...(profile.username ? ["-l", profile.username] : []),
      "-p",
      String(profile.port),
      "--",
      profile.host,
    ]);
    const host = /^hostname (.+)$/m.exec(config)?.[1]?.trim();
    const port = Number(/^port (\d+)$/m.exec(config)?.[1] ?? profile.port);
    if (!host || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("SSH configuration resolves to an invalid host.");
    // keyscan is only a candidate. Explicit fingerprint verification is mandatory before it becomes trusted.
    const keys = await run("ssh-keyscan", ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", host]);
    const key = keys
      .split(/\r?\n/)
      .find(
        (line) => !line.startsWith("#") && /^\S+ (ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+$/.test(line),
      );
    if (!key)
      throw new Error(
        "No SSH host key was returned. Add the verified key to known_hosts manually if this host requires ProxyJump.",
      );
    const keyBytes = Buffer.from(key.split(" ")[2]!, "base64");
    const fingerprint = `SHA256:${createHash("sha256").update(keyBytes).digest("base64").replace(/=+$/, "")}`;
    const challenge = { fingerprint, knownHostLine: key, host, port };
    this.challenges.set(profile.id, challenge);
    return challenge;
  }
  async trustHost(profileId: string, fingerprint: string): Promise<void> {
    const challenge = this.challenges.get(profileId);
    if (!challenge || challenge.fingerprint !== fingerprint)
      throw new Error("The SSH fingerprint changed. Inspect the host again.");
    await mkdir(path.dirname(this.knownHostsFile), { recursive: true, mode: 0o700 });
    await appendFile(this.knownHostsFile, `${challenge.knownHostLine}\n`, { mode: 0o600 });
    this.challenges.delete(profileId);
  }
  async connect(
    profile: SshConnectionProfile,
    onAuthentication: (url: string) => void,
    signal?: AbortSignal,
  ): Promise<SshTunnel> {
    validateConnectionProfile(profile);
    await mkdir(path.dirname(this.knownHostsFile), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new Error("The SSH connection was cancelled.");
      const localPort = await freePort();
      const child = spawn("ssh", buildSshArguments(profile, this.knownHostsFile, localPort), {
        shell: false,
        windowsHide: true,
        stdio: "pipe",
      });
      const endpoint = `http://127.0.0.1:${localPort}`;
      let stderr = "";
      let closed = false;
      let spawnError = false;
      const closeListeners = new Set<() => void>();
      const close = (): void => {
        closed = true;
        child.kill();
      };
      signal?.addEventListener("abort", close, { once: true });
      child.once("error", () => {
        spawnError = true;
        closed = true;
      });
      child.once("close", () => {
        closed = true;
        signal?.removeEventListener("abort", close);
        for (const listener of closeListeners) listener();
      });
      child.stdin.end();
      child.stdout.resume();
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-SSH_LIMIT);
        const url = tailscaleAuthenticationUrl(stderr);
        if (url && profile.sshAuthMode === "tailscale-ssh") onAuthentication(url);
      });
      try {
        await this.waitReady(child, endpoint, `127.0.0.1:${profile.remotePort}`, () => closed, signal);
        return {
          endpoint,
          hostHeader: `127.0.0.1:${profile.remotePort}`,
          close,
          onClose: (listener) => {
            closeListeners.add(listener);
            return () => {
              closeListeners.delete(listener);
            };
          },
          pair: async () => {
            const output = await run("ssh", buildSshArguments(profile, this.knownHostsFile, undefined, true), 120000, {
              signal,
              onStderr: (output) => {
                const url = tailscaleAuthenticationUrl(output);
                if (url && profile.sshAuthMode === "tailscale-ssh") onAuthentication(url);
              },
            });
            let value: unknown;
            try {
              value = JSON.parse(output);
            } catch {
              throw new Error(
                "wispctl returned an invalid pairing response. Check that it is installed for the SSH user.",
              );
            }
            const code = (value as { code?: unknown })?.code;
            if (typeof code !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(code))
              throw new Error("wispctl returned an invalid pairing code.");
            return code;
          },
        };
      } catch {
        close();
        if (signal?.aborted) throw new Error("The SSH connection was cancelled.");
        if (spawnError)
          throw new SshConnectionError(
            "missing_client",
            "Install the operating system OpenSSH client and restart Wisp.",
          );
        if (/Address already in use/i.test(stderr) && attempt < 2) continue;
        if (stderr) throw classifySshFailure(stderr);
        throw new SshConnectionError(
          "backend_unavailable",
          "SSH connected, but Wisp is not ready on the remote loopback port. Check the Wisp service and configured port.",
        );
      }
    }
    throw new Error("Could not allocate an SSH forwarding port.");
  }
  private async waitReady(
    child: ChildProcessWithoutNullStreams,
    endpoint: string,
    hostHeader: string,
    closed: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 120000;
    while (!closed() && Date.now() < deadline && !signal?.aborted) {
      try {
        const response = await createTunnelFetch(endpoint, hostHeader)(`${endpoint}/health/ready`, {
          headers: { Host: hostHeader },
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        /* SSH may be waiting for a Tailscale check. */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 250);
        function done(): void {
          clearTimeout(timer);
          child.off("close", done);
          resolve();
        }
        child.once("close", done);
      });
    }
    throw new Error("SSH tunnel is not ready.");
  }
}
