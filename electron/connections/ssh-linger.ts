import { FatalTransportError } from "../../client/remote-session.js";
import type { SshConnectionProfile } from "../../shared/connections.js";
import { run } from "./ssh-check.js";
import { sshArguments } from "./ssh-tunnel.js";

/** Turns linger on without a password when the system allows it; exit 3 means sudo needs one, 4 that there is no sudo. */
export const LINGER_SCRIPT = `user=$(id -un)
loginctl show-user "$user" --property=Linger 2>/dev/null | grep -q '=yes$' && exit 0
loginctl enable-linger "$user" 2>/dev/null && exit 0
command -v sudo >/dev/null 2>&1 || exit 4
sudo -n loginctl enable-linger "$user" 2>/dev/null && exit 0
exit 3`;

// sudo reads the password from stdin (-S) and prints no prompt (-p ""). Run by sh, whatever the login shell is.
const SUDO_COMMAND = `sh -c 'sudo -S -p "" loginctl enable-linger "$(id -un)"'`;

export interface LingerOptions {
  sshPath?: string;
  identityFile?: string;
  /** Asks the person for their sudo password; undefined cancels. */
  askPassword: () => Promise<string | undefined>;
  signal?: AbortSignal;
}

/**
 * Keeps the Wisp server running after the person logs out of the machine:
 * systemd stops user services at logout unless linger is on. Asks for the
 * sudo password only when the machine requires it; the password goes to
 * sudo's stdin and is never stored.
 */
export async function enableLinger(profile: SshConnectionProfile, options: LingerOptions): Promise<void> {
  const ssh = options.sshPath ?? "ssh";
  const args = ["-T", ...sshArguments(profile, { identityFile: options.identityFile }), "--", profile.host];
  const cancelled = (): FatalTransportError => new FatalTransportError("Turning on linger was cancelled.");
  const first = await run(ssh, [...args, "sh -s"], LINGER_SCRIPT);
  if (first.ok) return;
  if (options.signal?.aborted) throw cancelled();
  if (first.code === 4) {
    throw new FatalTransportError(
      `${profile.host} has no sudo. Ask its administrator to run \`loginctl enable-linger\` for your account.`,
    );
  }
  if (first.code !== 3) {
    throw new FatalTransportError(
      `Could not turn on linger on ${profile.host}: ${lastLine(first.stderr) || "ssh failed"}.`,
    );
  }
  const password = await options.askPassword();
  if (password === undefined || options.signal?.aborted) throw cancelled();
  const sudo = await run(ssh, [...args, SUDO_COMMAND], `${password}\n`);
  if (sudo.ok) return;
  if (/not in the sudoers|not allowed to run sudo|may not run sudo/i.test(sudo.stderr)) {
    throw new FatalTransportError(
      `Your account on ${profile.host} cannot use sudo. Ask its administrator to run \`loginctl enable-linger\` for it.`,
    );
  }
  if (/incorrect password|Sorry, try again|no password was provided/i.test(sudo.stderr)) {
    throw new FatalTransportError(`sudo on ${profile.host} did not accept the password.`);
  }
  throw new FatalTransportError(
    `Could not turn on linger on ${profile.host}: ${lastLine(sudo.stderr) || "sudo failed"}.`,
  );
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "";
}
