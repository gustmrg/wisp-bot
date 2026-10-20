/**
 * The `claude-code` provider: Claude Code's model aliases, which the person's
 * installed `claude` resolves to the newest model it knows (ADR 026).
 */

import { CLAUDE_CODE_PROVIDER } from "../../shared/claude-code.js";

export { CLAUDE_CODE_PROVIDER };
export const CLAUDE_CODE_PROVIDER_NAME = "Claude Code";

/**
 * Claude Code's current models run with a 1M-token window. Claude Code manages
 * its own context and output limits, so a Wisp's output limit is not applied.
 */
const CONTEXT_WINDOW = 1_000_000;
const MAX_OUTPUT_TOKENS = 64_000;

/**
 * `fable` and `best` are left out: Fable can bill usage credits instead of the
 * plan. `opusplan` and the `[1m]` variants do not apply to Wisps.
 */
const ALIASES = [
  { id: "default", name: "Default (your plan's default model)" },
  { id: "opus", name: "Opus (latest)" },
  { id: "sonnet", name: "Sonnet (latest)" },
  { id: "haiku", name: "Haiku (latest)" },
] as const;

export interface ClaudeCodeModel {
  id: string;
  name: string;
  provider: typeof CLAUDE_CODE_PROVIDER;
  api: "claude-code";
  baseUrl: string;
  reasoning: true;
  /** Wisp's reasoning levels map to Claude Code's effort; there is no "minimal" effort. */
  thinkingLevelMap: { minimal: null; xhigh: "xhigh"; max: "max" };
  input: ["text", "image"];
  cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
  contextWindow: number;
  maxTokens: number;
}

export const CLAUDE_CODE_MODELS: ReadonlyArray<ClaudeCodeModel> = ALIASES.map(({ id, name }) => ({
  id,
  name,
  provider: CLAUDE_CODE_PROVIDER,
  api: "claude-code",
  baseUrl: "",
  reasoning: true,
  thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: CONTEXT_WINDOW,
  maxTokens: MAX_OUTPUT_TOKENS,
}));

export function claudeCodeModel(modelId: string): ClaudeCodeModel | undefined {
  return CLAUDE_CODE_MODELS.find(({ id }) => id === modelId);
}
