import type { ChatId, ChatSummary, CircleSummary, WispSummary } from "@/chat-data";

export function isWisp(chat: ChatSummary): chat is WispSummary {
  return chat.kind === "wisp";
}

export function isCircle(chat: ChatSummary): chat is CircleSummary {
  return chat.kind === "circle";
}

export function getDefaultChatId(chats: Readonly<Record<ChatId, ChatSummary>>): ChatId {
  return Object.values(chats).find((chat) => chat.systemRole === "chief")?.id ?? Object.keys(chats)[0] ?? "";
}

export function canDeleteChat(chat: ChatSummary): boolean {
  return chat.systemRole !== "chief";
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected chat variant: ${JSON.stringify(value)}`);
}
