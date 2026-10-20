import { randomUUID } from "node:crypto";
import { appendFile, readdir } from "node:fs/promises";
import path from "node:path";

import { CLAUDE_CODE_PROVIDER } from "../../shared/claude-code.js";
import { FALLBACK_ENTRY } from "../model-fallback.js";
import type { ClaudeCodeTurnResult } from "./claude-code-events.js";

/**
 * A Claude Code Wisp's turns, in the Wisp's session folder, as entries shaped
 * like Pi's session entries, so the session report and Token usage read them
 * as they read Pi's sessions (ADR 026). Claude Code keeps the conversation
 * itself; this log holds only each turn's model and token usage.
 */
export const CLAUDE_CODE_USAGE_FILE = "claude-code-usage.jsonl";

/** Where the Pi sessions of a Claude Code Wisp's fallback model live, one folder per turn, inside its session folder. */
export const CLAUDE_CODE_FALLBACK_DIRECTORY = "claude-code-fallback";

/** Who pays for a turn: the person's Claude plan, or their Anthropic API account. */
export type ClaudeCodeBilling = "subscription" | "api";

function entryBase(at: Date) {
  return { id: randomUUID().slice(0, 8), parentId: null, timestamp: at.toISOString() };
}

/**
 * A turn's entry. A plan's turn is marked so it costs nothing more; an API
 * account's carries Claude Code's estimate of what it cost.
 */
export function claudeCodeUsageEntry(
  result: ClaudeCodeTurnResult,
  model: string,
  billing: ClaudeCodeBilling,
  costUsd: number | null,
  at: Date,
) {
  const { usage } = result;
  return {
    type: "message",
    ...entryBase(at),
    message: {
      role: "assistant",
      api: CLAUDE_CODE_PROVIDER,
      provider: CLAUDE_CODE_PROVIDER,
      model,
      content: [],
      usage: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
        cost: { total: billing === "subscription" ? 0 : (costUsd ?? 0) },
      },
      ...(billing === "subscription" ? { billing: "plan" } : {}),
      stopReason: result.ok ? "stop" : "error",
      timestamp: at.getTime(),
    },
  };
}

/** The fallback model answered a turn, as Pi's sessions record it. */
export function claudeCodeFallbackEntry(model: string, at: Date) {
  return { type: "custom", ...entryBase(at), customType: FALLBACK_ENTRY, data: { model } };
}

export async function appendClaudeCodeUsage(sessionDirectory: string, entry: object): Promise<void> {
  await appendFile(path.join(sessionDirectory, CLAUDE_CODE_USAGE_FILE), `${JSON.stringify(entry)}\n`, "utf8");
}

/** The session files of the fallback model's turns, oldest first. */
export async function claudeCodeFallbackSessionFiles(sessionDirectory: string): Promise<string[]> {
  const root = path.join(sessionDirectory, CLAUDE_CODE_FALLBACK_DIRECTORY);
  let turns: string[];
  try {
    turns = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const turn of turns) {
    const names = await readdir(path.join(root, turn)).catch(() => []);
    for (const name of names.filter((file) => file.endsWith(".jsonl")).sort()) files.push(path.join(root, turn, name));
  }
  return files;
}
