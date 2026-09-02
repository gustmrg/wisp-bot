import type { Chat, ChatId, CircleChat, WispChat } from "@/chat-data";

export function isWisp(chat: Chat): chat is WispChat {
  return chat.kind === "wisp";
}

export function isCircle(chat: Chat): chat is CircleChat {
  return chat.kind === "circle";
}

export function getDefaultChatId(chats: Readonly<Record<ChatId, Chat>>): ChatId {
  return Object.values(chats).find((chat) => chat.systemRole === "chief")?.id ?? Object.keys(chats)[0] ?? "";
}

export function canDeleteChat(chat: Chat): boolean {
  return chat.systemRole !== "chief";
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected chat variant: ${JSON.stringify(value)}`);
}
