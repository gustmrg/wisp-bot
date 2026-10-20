/** How a circle's messages address its members (ADR 011). */

interface Member {
  id: string;
  name: string;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * The members a text mentions with `@` and their name, each once, in the
 * order they are first mentioned. Names match without regard to case and
 * must end the mention (`@Ada` does not mention Adam); the longest name wins
 * when names share a prefix. An `@` inside a word, as in an email address,
 * mentions no one.
 */
export function mentionedMembers(text: string, members: ReadonlyArray<Member>): string[] {
  const byLength = [...members].filter(({ name }) => name.trim()).sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && WORD_CHARACTER.test(text[at - 1]!)) continue;
    const member = byLength.find(({ name }) => {
      const end = at + 1 + name.length;
      return text.slice(at + 1, end).toLowerCase() === name.toLowerCase() && !WORD_CHARACTER.test(text[end] ?? "");
    });
    if (member && !found.includes(member.id)) found.push(member.id);
  }
  return found;
}

/** Who answers a message to a circle: the members it mentions, or else its lead, the first member. */
export function circleRecipients(text: string, members: ReadonlyArray<Member>): string[] {
  const mentioned = mentionedMembers(text, members);
  if (mentioned.length) return mentioned;
  return members[0] ? [members[0].id] : [];
}
