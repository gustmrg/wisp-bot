import type { Message } from "@/chat-data";
import { messageSearchFragments } from "../../shared/message-search";

export { messageSearchText } from "../../shared/message-search";

export interface MessageSearchMatch {
  message: Message;
  snippet: string;
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
