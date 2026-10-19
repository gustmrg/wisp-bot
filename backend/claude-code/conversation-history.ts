import type { Message, MessagePage, MessageSearchHit } from "../../shared/conversations.js";

/** How much of the latest conversation a replacement Claude Code session is told. */
const MAX_TRANSCRIPT_CHARACTERS = 8_000;
const MAX_SEARCH_HITS = 10;

function textOf(message: Message): { speaker: string; text: string } | undefined {
  if (message.type !== "incoming" && message.type !== "outgoing") return undefined;
  const text = message.text.trim();
  if (!text) return undefined;
  return { speaker: message.type === "outgoing" ? "User" : "Wisp", text };
}

/**
 * The latest of a conversation's messages, oldest first, as plain lines for a
 * Claude Code session that replaces one Claude Code no longer has (ADR 026).
 * The newest messages are kept when the whole page does not fit.
 */
export function recentTranscript(page: MessagePage): string {
  const lines: string[] = [];
  let length = 0;
  for (const message of [...page.messages].reverse()) {
    const entry = textOf(message);
    if (!entry) continue;
    const line = `${entry.speaker}: ${entry.text}`;
    if (length + line.length > MAX_TRANSCRIPT_CHARACTERS) {
      if (!lines.length) lines.push(`${line.slice(0, MAX_TRANSCRIPT_CHARACTERS - 1)}…`);
      break;
    }
    lines.push(line);
    length += line.length + 2;
  }
  return lines.reverse().join("\n\n");
}

/**
 * What `search_history` returns for a Claude Code Wisp: the conversation's
 * matching messages, newest first. Claude Code keeps its own history, so the
 * Wisp's transcript is searched instead of Pi's session.
 */
export function formatHistorySearch(conversationId: string, hits: ReadonlyArray<MessageSearchHit>): string {
  const own = hits.filter((hit) => hit.conversationId === conversationId).slice(0, MAX_SEARCH_HITS);
  if (!own.length) return "No earlier messages match.";
  return own.map((hit) => `${hit.createdAt ? `[${hit.createdAt}] ` : ""}${hit.snippet}`).join("\n\n");
}
