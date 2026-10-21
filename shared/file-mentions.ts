/** How a message to a Wisp points to files in its workspace with `@`. */

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
/** An `@` and a path: quoted when it holds spaces, otherwise running to the next space. */
const FILE_MENTION = /@(?:"([^"\n]+)"|([^\s@"]+))/gu;
/** Punctuation that ends the sentence around an unquoted path rather than the path itself. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'’]+$/u;

/** Longest query a file search accepts. */
export const MAX_FILE_MENTION_QUERY_LENGTH = 256;
/** Most files a file search returns. */
export const MAX_FILE_MENTION_RESULTS = 8;

/**
 * The paths matching what follows an `@`, best first: those whose file name
 * starts with it, then those whose path starts with it, then those whose path
 * holds it, each in the order given. A leading quote, as in a path with
 * spaces being typed, is not part of what is looked for.
 */
export function rankFilePaths(paths: ReadonlyArray<string>, query: string, limit = MAX_FILE_MENTION_RESULTS): string[] {
  const wanted = query.replace(/^"/, "").toLowerCase();
  const ranked: Array<{ path: string; rank: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const rank = name.startsWith(wanted) ? 0 : lower.startsWith(wanted) ? 1 : lower.includes(wanted) ? 2 : -1;
    if (rank >= 0) ranked.push({ path, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ path }) => path);
}

/** Where a text mentions a file: `text.slice(start, end)` is the `@` and the path. */
export interface FileMentionRange {
  start: number;
  end: number;
  /** Relative to the workspace root, as written. */
  path: string;
}

/** What follows the `@` that mentions a workspace file: its path, quoted when it holds spaces. */
export function fileMentionText(path: string): string {
  return /\s/u.test(path) ? `"${path}"` : path;
}

/**
 * Every mention of a file in a text, in order. An `@` inside a word, as in an
 * email address, mentions nothing, and punctuation closing the sentence after
 * an unquoted path is not part of it.
 */
export function fileMentionRanges(text: string): FileMentionRange[] {
  const ranges: FileMentionRange[] = [];
  for (const match of text.matchAll(FILE_MENTION)) {
    const start = match.index;
    if (start > 0 && WORD_CHARACTER.test(text[start - 1]!)) continue;
    const quoted = match[1];
    const path = quoted ?? match[2]!.replace(TRAILING_PUNCTUATION, "");
    if (!path) continue;
    ranges.push({ start, end: quoted ? start + match[0].length : start + 1 + path.length, path });
  }
  return ranges;
}
