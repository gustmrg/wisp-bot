import type { Message } from "./conversations.js";

/** Messages shorter than this cannot be matched by the trigram search index. */
export const MIN_MESSAGE_SEARCH_LENGTH = 3;
export const MAX_MESSAGE_SEARCH_LENGTH = 200;

/**
 * The searchable text of a message, as separate fragments. The backend search
 * index derives the same text in SQL (see `conversation-store.ts`); a test
 * keeps the two in agreement for every message type.
 */
export function messageSearchFragments(message: Message): ReadonlyArray<string> {
  switch (message.type) {
    case "incoming":
    case "outgoing":
      return [message.text];
    case "card":
      return message.items.map(({ label, text }) => `${label} — ${text}`);
    case "prompt":
      return [
        message.question,
        ...message.options.map(({ key, label }) => `${key} ${label}`),
        ...(message.answer ? [message.answer] : []),
      ];
    case "time":
      return [];
    default:
      return assertNever(message);
  }
}

export function messageSearchText(message: Message): string {
  return messageSearchFragments(message).join(" ");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported message type: ${JSON.stringify(value)}`);
}
