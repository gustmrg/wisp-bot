import type { ChatId, ChatSummaryCollection } from "@/chat-data";
import { getDefaultChatId } from "@/lib/chat-schema";

export type ChatIdFactory = (chats: ChatSummaryCollection) => ChatId;

export function createChatIdFactory(createId: () => string = () => crypto.randomUUID()): ChatIdFactory {
  const issuedIds = new Set<ChatId>();
  return (chats) => {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const id = createId();
      if (!chats[id] && !issuedIds.has(id)) {
        issuedIds.add(id);
        return id;
      }
    }
    throw new Error("Could not allocate a unique conversation ID.");
  };
}

export function selectActiveChatId(chats: ChatSummaryCollection, currentId: ChatId): ChatId {
  return chats[currentId] ? currentId : getDefaultChatId(chats);
}
