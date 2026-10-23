import type { MemoryEntry, MemoryScope, MemoryUsage } from "./types.js";

/** The rendered block of each scope and the exported file's name (ADR 029). */
export const MEMORY_FILE_NAMES: Readonly<Record<MemoryScope, string>> = { user: "USER.md", wisp: "MEMORY.md" };

const SCOPES: readonly MemoryScope[] = ["user", "wisp"];

const formatNumber = new Intl.NumberFormat("en-US");

/**
 * Active entries as the prompt shows them: `USER.md`, then `MEMORY.md`, each
 * line with its ID for patch and remove. The same memory always gives the same
 * text, so the prompt cache holds while nothing changes.
 */
export function renderMemoryForPrompt(entries: readonly MemoryEntry[], usage: readonly MemoryUsage[]): string {
  return SCOPES.map((scope) => {
    const { used = 0, limit = 0 } = usage.find((item) => item.scope === scope) ?? {};
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const lines = entries.filter((entry) => entry.scope === scope).map((entry) => `- [${entry.id}] ${entry.text}`);
    return [
      `### ${MEMORY_FILE_NAMES[scope]} · ${percent}% of ${formatNumber.format(limit)} characters`,
      ...(lines.length > 0 ? lines : ["(empty)"]),
    ].join("\n");
  }).join("\n\n");
}

/** One scope's active entries as a Markdown file, without IDs. */
export function exportMemoryMarkdown(scope: MemoryScope, entries: readonly MemoryEntry[]): string {
  const lines = entries.filter((entry) => entry.scope === scope).map((entry) => `- ${entry.text}`);
  return [`# ${MEMORY_FILE_NAMES[scope]}`, ...(lines.length > 0 ? ["", ...lines] : [])].join("\n") + "\n";
}
