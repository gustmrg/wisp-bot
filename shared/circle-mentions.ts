/** How a circle's messages address its members (ADR 011). */

interface Member {
  id: string;
  name: string;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/** Where a text mentions a member: `text.slice(start, end)` is the `@` and the name. */
export interface MentionRange {
  start: number;
  end: number;
  memberId: string;
}

/**
 * Every mention of a member in a text, in order. Names match without regard
 * to case and must end the mention (`@Ada` does not mention Adam); the
 * longest name wins when names share a prefix. An `@` inside a word, as in
 * an email address, mentions no one.
 */
export function mentionRanges(text: string, members: ReadonlyArray<Member>): MentionRange[] {
  const byLength = [...members].filter(({ name }) => name.trim()).sort((a, b) => b.name.length - a.name.length);
  const ranges: MentionRange[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && WORD_CHARACTER.test(text[at - 1]!)) continue;
    const member = byLength.find(({ name }) => {
      const end = at + 1 + name.length;
      return text.slice(at + 1, end).toLowerCase() === name.toLowerCase() && !WORD_CHARACTER.test(text[end] ?? "");
    });
    if (!member) continue;
    ranges.push({ start: at, end: at + 1 + member.name.length, memberId: member.id });
    at += member.name.length;
  }
  return ranges;
}

/** The members a text mentions (see `mentionRanges`), each once, in the order they are first mentioned. */
export function mentionedMembers(text: string, members: ReadonlyArray<Member>): string[] {
  return [...new Set(mentionRanges(text, members).map(({ memberId }) => memberId))];
}

/** Who answers a message to a circle: the members it mentions, or else its lead, the first member. */
export function circleRecipients(text: string, members: ReadonlyArray<Member>): string[] {
  const mentioned = mentionedMembers(text, members);
  if (mentioned.length) return mentioned;
  return members[0] ? [members[0].id] : [];
}
