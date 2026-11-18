/**
 * How many Claude Code turns are running, in chats and jobs, so `claude` is
 * never updated under one (ADR 047). A process idle between turns does not
 * count: it keeps running the version it started with.
 */
export class ClaudeCodeActivity {
  private running = 0;

  get busy(): boolean {
    return this.running > 0;
  }

  /** Counts a turn as running until the returned function is called. */
  begin(): () => void {
    this.running += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.running -= 1;
    };
  }
}
