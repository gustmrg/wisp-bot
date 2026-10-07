import type {
  ChatId,
  ChatSummaryCollection,
  ChatView,
  ChatViewCollection,
  CircleChatView,
  WispChatView,
  WispCollection,
} from "@/chat-data";

export function isWisp(chat: ChatView): chat is WispChatView {
  return chat.kind === "wisp";
}

export function isCircle(chat: ChatView): chat is CircleChatView {
  return chat.kind === "circle";
}

/** The name a conversation shows: its Wisp's, or the circle's own. */
export function chatName(chat: ChatView): string {
  return chat.kind === "wisp" ? chat.wisp.name : chat.name;
}

/**
 * Joins conversation summaries with the Wisps they involve. A Wisp's
 * conversation whose Wisp is missing is left out, as are circle members
 * that no longer exist.
 */
export function chatViews(chats: ChatSummaryCollection, wisps: WispCollection): ChatViewCollection {
  const views: ChatViewCollection = {};
  for (const [id, chat] of Object.entries(chats)) {
    if (chat.kind === "wisp") {
      const wisp = wisps[chat.wispId];
      if (wisp) views[id] = { ...chat, wisp };
    } else {
      views[id] = {
        ...chat,
        members: [...new Set(chat.memberIds)].flatMap((memberId) => (wisps[memberId] ? [wisps[memberId]] : [])),
      };
    }
  }
  return views;
}

export function getDefaultChatId(chats: Readonly<Record<ChatId, ChatView>>): ChatId {
  return Object.keys(chats)[0] ?? "";
}
