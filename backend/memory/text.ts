/** Formats that are credentials whatever surrounds them, and a value given right after a credential's name. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:password|passwd|senha|api[_ -]?key|access[_ -]?token|token|secret)\s*[:=]\s*\S{6,}/i,
];

/**
 * Line breaks, other control characters and invisible format characters, none
 * of which belong in one line of memory. The zero-width joiner stays: emoji
 * sequences need it.
 */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\u2028\u2029]|(?!\u200D)\p{Cf}/u;

/** An entry's text as stored, or why it cannot be one: one line, trimmed, not empty. */
export function memoryLine(text: string): { text: string } | { error: string } {
  const line = text.trim();
  if (!line) return { error: "A memory entry cannot be empty." };
  if (FORBIDDEN_CHARACTERS.test(line))
    return { error: "A memory entry is one line of plain text, without line breaks or invisible characters." };
  return { text: line };
}

/** Whether text looks like it holds a credential, which memory never keeps. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/** Characters as a person counts them: code points, so an emoji or an accented letter is one. */
export function characterCount(text: string): number {
  return [...text].length;
}
