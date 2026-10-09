import { spawn } from "node:child_process";

import { WispBackendError } from "../../backend/backend-error.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { sshArguments } from "./ssh-tunnel.js";

/** Only fixed diagnostics leave this process: SSH output may contain secrets. */
export function sshTestFailure(stderr: string, missingClient = false): string {
  if (missingClient) return "OpenSSH is not installed on this computer. Install the ssh client and retry.";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* not known/i.test(stderr)) {
    return "The SSH host key is unknown or has changed. Verify the host key in a terminal before retrying.";
  }
  if (/login\.tailscale\.com|tailscale.*(check|approval)/i.test(stderr)) {
    return "Tailscale SSH requires approval. Connect with SSH in a terminal to approve it, then retry.";
  }
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(stderr)) {
    return "SSH authentication failed. Check the user and load the correct key into ssh-agent or configure it in ~/.ssh/config.";
  }
  if (/Could not resolve hostname/i.test(stderr))
    return "The SSH host could not be resolved. Check the host name and your network or tailnet connection.";
  if (/Connection refused/i.test(stderr))
    return "The SSH connection was refused. Check the SSH port and that SSH is running on the server.";
  if (/timed out|No route to host|Network is unreachable/i.test(stderr))
    return "The SSH server could not be reached. Check the host, port, firewall, and network or tailnet connection.";
  return "The SSH test failed. Check the SSH configuration and try connecting in a terminal for more details.";
}

/** Authenticates and runs a fixed no-op, without pairing, installing, or changing the active connection. */
export function testSshConnection(
  profile: SshConnectionProfile,
  options: { sshPath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ message: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new WispBackendError("unavailable", "The SSH test was cancelled.", true));
      return;
    }
    const child = spawn(
      options.sshPath ?? "ssh",
      [
        "-T",
        ...sshArguments(profile),
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "--",
        profile.host,
        "true",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    let failure: string | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const stop = () => {
      child.kill("SIGKILL");
    };
    const abort = () => {
      failure = "The SSH test was cancelled.";
      stop();
    };
    const timer = setTimeout(() => {
      failure = "The SSH test timed out. Check the host, SSH port, network, and authentication configuration.";
      stop();
    }, options.timeoutMs ?? 20_000);
    process.once("exit", stop);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure = sshTestFailure("", error.code === "ENOENT");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      process.off("exit", stop);
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(new WispBackendError("unavailable", failure ?? sshTestFailure(stderr), true));
      else
        resolve({
          message:
            "SSH connection successful. Authentication worked. The Wisp server and its port have not been tested.",
        });
    });
  });
}
