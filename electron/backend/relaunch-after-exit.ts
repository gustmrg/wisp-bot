import { spawn } from "node:child_process";

type Spawner = (command: string, args: string[]) => void;

// Waits for the given process to exit, then starts the app again. The wait keeps
// the new instance from losing the single-instance lock to the one shutting down.
const WAIT_THEN_EXEC = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@"';

/**
 * Starts the app again once this process exits, without `app.relaunch()`.
 *
 * On Linux, Electron starts the relaunched process with `no_new_privs` set, so
 * setuid binaries such as pkexec and sudo cannot raise privileges from it and
 * the next package-manager update (deb, rpm, pacman) fails until the user
 * reopens the app by hand. A detached shell spawned from this process does not
 * carry the flag.
 */
export function relaunchAfterExit(
  pid: number,
  execPath: string,
  args: readonly string[],
  spawner: Spawner = detachedSpawn,
): void {
  spawner("/bin/sh", ["-c", WAIT_THEN_EXEC, "sh", String(pid), execPath, ...args]);
}

function detachedSpawn(command: string, args: string[]): void {
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
