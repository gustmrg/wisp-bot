/** The provider of Wisps that run on the person's Claude Code (ADR 026). */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/**
 * Whether this server's `claude` can run Wisps: installed, at least the
 * version Wisp needs, and signed in. "checking" is shown until the first
 * check finishes.
 */
export type ClaudeCodeStatusView =
  | { state: "checking" }
  | { state: "missing" }
  | { state: "outdated"; version: string; minimumVersion: string }
  | { state: "signed_out"; version: string }
  /** `billing` says who pays: the person's Claude plan, or their Anthropic API account. */
  | { state: "ready"; version: string; billing: "subscription" | "api"; plan?: string };

/** Why Claude Code cannot run a Wisp now, in words the person can act on; undefined when it can. */
export function claudeCodeUnavailableMessage(status: ClaudeCodeStatusView | undefined): string | undefined {
  switch (status?.state) {
    case "ready":
      return undefined;
    case "outdated":
      return `Claude Code ${status.version} is too old. Run \`claude update\` on the server's computer to get ${status.minimumVersion} or newer.`;
    case "signed_out":
      return "Claude Code is not signed in. Run `claude auth login` on the server's computer.";
    case "missing":
      return "Claude Code is not installed on the server's computer.";
    default:
      return "Checking Claude Code on the server's computer. Try again in a moment.";
  }
}
