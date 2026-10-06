import { spawn } from "node:child_process";

import { FatalTransportError } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { SERVER_VERSION_PATTERN, WISP_SERVER_PACKAGE } from "../../shared/server-package.js";
import { classify, sshArguments } from "./ssh-tunnel.js";

// Downloading the package and its dependencies can take a while on a small machine.
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 16 * 1024;

export interface SshInstallOptions {
  /** The version of this app; the server it installs is always the same version. */
  version: string;
  /** The OpenSSH client; tests substitute a fake. */
  sshPath?: string;
  signal?: AbortSignal;
  /** Called with each line the setup reports, such as "Installing…". */
  onProgress?: (message: string) => void;
}

/**
 * The command run on the server. The remote shell sees only the app's own
 * version and the profile's port, both validated; never text from the user.
 * ~/.local/bin is added because it is often missing from the PATH of
 * non-interactive SSH sessions. Without a terminal, ending ssh does not stop
 * the remote command, so it stops itself when its stdin closes.
 */
export function installCommand(version: string, serverPort: number): string {
  if (!SERVER_VERSION_PATTERN.test(version))
    throw new FatalTransportError(`${version} is not a version Wisp can install.`);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new FatalTransportError("The server port is invalid.");
  }
  return `PATH="$HOME/.local/bin:$PATH" npx --yes ${WISP_SERVER_PACKAGE}@${version} setup --json --no-pair --until-stdin-closes --port ${serverPort}`;
}

/** Installs and starts the Wisp server on a machine reached over SSH, by running its `setup` there. */
export async function installRemoteServer(profile: SshConnectionProfile, options: SshInstallOptions): Promise<void> {
  const child = spawn(
    options.sshPath ?? "ssh",
    ["-T", ...sshArguments(profile), "--", profile.host, installCommand(options.version, profile.serverPort)],
    // stdin stays open and silent: closing it is how the setup learns it was cancelled.
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  child.stdin?.on("error", () => undefined);
  let stdout = "";
  let stderr = "";
  let pending = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-MAX_OUTPUT);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_OUTPUT);
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const message = line.trim();
      // npm's own chatter is not about Wisp.
      if (message && !/^npm /i.test(message)) options.onProgress?.(message.slice(0, 160));
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, INSTALL_TIMEOUT_MS);
  const stop = (): void => void child.kill("SIGTERM");
  options.signal?.addEventListener("abort", stop, { once: true });
  let spawnError: Error | undefined;
  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  clearTimeout(timer);
  child.stdin?.destroy();
  options.signal?.removeEventListener("abort", stop);
  if (options.signal?.aborted) throw new FatalTransportError("Installing the server was cancelled.");
  if (code === 0 && /^\{.*\}$/m.test(stdout)) return;
  throw explainInstallFailure(profile.host, options.version, code, stderr, timedOut, spawnError);
}

/** Why the setup over SSH failed, in terms of what to do on the server. */
export function explainInstallFailure(
  host: string,
  version: string,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  spawnError?: Error,
): FatalTransportError {
  if (timedOut) {
    return new FatalTransportError(
      `Installing on ${host} took more than ${INSTALL_TIMEOUT_MS / 60_000} minutes. Check its internet connection, or run \`npx ${WISP_SERVER_PACKAGE} setup\` there.`,
    );
  }
  // OpenSSH exits with 255 when the connection itself failed.
  if (spawnError || exitCode === 255) return new FatalTransportError(classify(stderr, host, spawnError).message);
  if (
    /npx: (command )?not found|npx: No such file|env: .?(node|npx).?: No such file/i.test(stderr) ||
    exitCode === 127
  ) {
    return new FatalTransportError(
      `Node.js is missing on ${host}, or not in the PATH of SSH commands. Install Node.js 22.19 or later there, then retry.`,
    );
  }
  const last = stderr
    .trim()
    .split("\n")
    .filter((line) => !/^npm (warn|notice)/i.test(line))
    .pop();
  if (/Wisp needs Node\.js/i.test(stderr)) {
    return new FatalTransportError(`${last ?? "Node.js is too old"} (on ${host})`);
  }
  if (/E404|404 Not Found|is not published on npm/i.test(stderr)) {
    return new FatalTransportError(
      `Wisp server ${version} is not published on npm, so ${host} cannot install it. Update Wisp to a released version, or set the server up by hand (see “How to set up a Wisp server”).`,
    );
  }
  return new FatalTransportError(`Could not set up the Wisp server on ${host}${last ? `: ${last}` : "."}`);
}
