import type { ChatId, ChatListAction, ChatView, ChatViewCollection } from "@/chat-data";
import type { BackendError, WispApi } from "../../../shared/contracts";
import { getDefaultChatId } from "@/lib/chat-schema";

export type ChatIdFactory = (chats: ChatViewCollection) => ChatId;

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

export function selectActiveChatId(chats: ChatViewCollection, currentId: ChatId): ChatId {
  return chats[currentId] ? currentId : getDefaultChatId(chats);
}

/**
 * Conversations whose error is newer than the one last seen in them. The open
 * conversation shows its own error, so it is never one of them.
 */
export function unseenFailures(
  errors: Readonly<Record<string, BackendError | undefined>>,
  seen: Readonly<Record<string, BackendError | undefined>>,
  activeChatId: ChatId,
): Record<string, boolean> {
  const failed: Record<string, boolean> = {};
  for (const [chatId, error] of Object.entries(errors)) {
    if (error && chatId !== activeChatId && seen[chatId] !== error) failed[chatId] = true;
  }
  return failed;
}

/**
 * A list action on a conversation of another environment, sent straight to
 * it; its pushed changes update the list.
 */
export async function applyEnvironmentChatAction(
  api: WispApi,
  chat: ChatView,
  action: ChatListAction,
): Promise<boolean> {
  const conversationId = chat.id;
  try {
    const result =
      action === "pin" || action === "unpin"
        ? await api.updateConversation({ conversationId, changes: { kind: chat.kind, pinned: action === "pin" } })
        : action === "mute" || action === "unmute"
          ? await api.updateConversation({
              conversationId,
              changes: { kind: chat.kind, notifyOnUpdatesEnabled: action === "unmute" },
            })
          : action === "read"
            ? await api.markConversationRead({ conversationId })
            : await api.markConversationUnread({ conversationId });
    return result.ok;
  } catch {
    return false;
  }
}
