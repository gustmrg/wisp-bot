import type { AgentSettings, Chat, ChatCollection } from "@/chat-data";
import { initialChats } from "@/chat-data";

export function migrateLegacyChannelMembers(chats: ChatCollection): ChatCollection {
  const offsite = chats.offsite;
  if (!offsite?.isGroup || offsite.memberIds !== undefined) return chats;

  // Only the bundled demo predates member selection; preserve explicit empty channels.
  const memberIds = (initialChats.offsite?.memberIds ?? []).filter((id) => chats[id] && !chats[id].isGroup);
  return { ...chats, offsite: { ...offsite, memberIds } };
}

export function getChannelMembers(chat: AgentSettings, chats: ChatCollection): Chat[] {
  if (!chat.isGroup) return [];
  return [...new Set(chat.memberIds ?? [])].flatMap((id) => {
    const member = chats[id];
    return member && !member.isGroup ? [member] : [];
  });
}
