import type { Message } from "@/chat-data";

export interface MessageSearchMatch {
  message: Message;
  snippet: string;
}

function messageSearchFragments(message: Message): ReadonlyArray<string> {
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

export function findMessageSearchMatch(
  messages: ReadonlyArray<Message>,
  query: string,
): MessageSearchMatch | undefined {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return undefined;

  for (const message of messages) {
    const snippet = messageSearchFragments(message).find((fragment) =>
      fragment.toLocaleLowerCase().includes(normalizedQuery),
    );
    if (snippet) return { message, snippet };
  }
  return undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported message type: ${JSON.stringify(value)}`);
}
