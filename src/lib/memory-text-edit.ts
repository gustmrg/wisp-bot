import type { MemoryEntryView, MemoryOperationRequest, MemoryScope } from "../../shared/memory";

export interface MemoryTextEdit {
  operations: MemoryOperationRequest[];
  added: number;
  removed: number;
}

/** One entry per non-blank line, trimmed, repeats left out. */
export function memoryTextLines(text: string): string[] {
  return [...new Set(text.split(/\r\n|\r|\n/).map((line) => line.trim()))].filter((line) => line.length > 0);
}

/**
 * What saving a scope edited as text changes (ADR 029): a line that is still
 * there keeps its entry, ID and metadata; an edited line removes the old entry
 * and adds a new one; a missing line is removed. Removals come first, so a
 * batch that frees room fits the limit.
 */
export function planMemoryTextEdit(
  scope: MemoryScope,
  active: ReadonlyArray<MemoryEntryView>,
  text: string,
): MemoryTextEdit {
  const lines = memoryTextLines(text);
  const kept = new Set<string>();
  const removals: MemoryOperationRequest[] = [];
  for (const entry of active) {
    if (entry.scope !== scope) continue;
    if (lines.includes(entry.text) && !kept.has(entry.text)) kept.add(entry.text);
    else removals.push({ op: "remove", id: entry.id });
  }
  const additions: MemoryOperationRequest[] = lines
    .filter((line) => !kept.has(line))
    .map((line) => ({ op: "add", scope, text: line }));
  return { operations: [...removals, ...additions], added: additions.length, removed: removals.length };
}

/** "2 added, 1 removed", or that nothing changed. */
export function describeMemoryTextEdit({ added, removed }: MemoryTextEdit): string {
  const parts = [...(added ? [`${added} added`] : []), ...(removed ? [`${removed} removed`] : [])];
  return parts.length ? parts.join(", ") : "No changes";
}
