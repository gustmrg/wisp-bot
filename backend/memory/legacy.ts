/** A list marker at the start of a line: `-`, `*`, `+`, `•`, or a number with `.` or `)`. */
const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s+/u;

/** Control and invisible format characters, which old free text may hold and an entry may not. */
const INVISIBLE = /[\p{Cc}\u2028\u2029]|(?!\u200D)\p{Cf}/gu;

/**
 * Free text from before memory had entries (the saved memory, the profile),
 * as entry lines: one per line or bullet, list markers dropped, blank lines
 * and repeats left out, order kept.
 */
export function splitLegacyMemory(text: string): string[] {
  const lines = text
    .split(/\r\n|\r|\n|\u2028|\u2029/u)
    .map((line) => line.replace(INVISIBLE, "").trim().replace(LIST_MARKER, "").trim())
    .filter((line) => line.length > 0);
  return [...new Set(lines)];
}
