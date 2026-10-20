import { execFile, spawn, type ChildProcess } from "node:child_process";

/** What the Agent SDK passes to `spawnClaudeCodeProcess`. */
export interface ClaudeCodeSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** How long a deleted Wisp waits for its Claude Code processes to exit before its data is purged anyway. */
const EXIT_WAIT_MS = 10_000;

/**
 * The Claude Code processes Wisp started, by workspace, so a deleted Wisp's
 * Claude Code data is purged only after its processes exited: a process that
 * is still closing would write its transcript again (ADR 026).
 */
export class ClaudeCodeProcesses {
  private readonly running = new Map<string, Set<Promise<void>>>();

  /**
   * Starts Claude Code the way the SDK does, as the docs' custom spawner
   * shows: the SDK's signal ends the process after its graceful close.
   * Claude Code's stderr is discarded.
   */
  readonly spawn = (options: ClaudeCodeSpawnOptions): ChildProcess => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const key = options.cwd ?? "";
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const set = this.running.get(key) ?? new Set();
    set.add(exited);
    this.running.set(key, set);
    void exited.then(() => {
      set.delete(exited);
      if (!set.size && this.running.get(key) === set) this.running.delete(key);
    });
    return child;
  };

  /** Resolves once every process started in the workspace exited, or after `timeoutMs`. */
  async whenExited(workspaceDirectory: string, timeoutMs = EXIT_WAIT_MS): Promise<void> {
    const exits = [...(this.running.get(workspaceDirectory) ?? [])];
    if (!exits.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(exits),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }
}

/** Deletes what Claude Code keeps for a workspace: transcripts, file history, and its project entry. */
export function purgeClaudeCodeProject(
  executable: string,
  workspaceDirectory: string,
  env: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["purge", workspaceDirectory, "--yes"],
      { env, timeout: 60_000, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
