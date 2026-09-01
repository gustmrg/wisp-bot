import type { AgentSettings, Chat, ChatCollection } from "@/chat-data";

const LEGACY_OFFSITE_MEMBER_IDS = ["chief", "inbox", "account"];

type LegacyChat = AgentSettings & { isGroup?: boolean };

export function migrateLegacyChats(chats: ChatCollection): ChatCollection {
  const migrated = Object.fromEntries(
    Object.entries(chats).map(([id, chat]) => {
      const { isGroup, ...rest } = chat as LegacyChat;
      const isCircle = rest.isCircle ?? isGroup ?? false;
      const label = isCircle && rest.label === "Channel" ? "Circle" : rest.label;
      return [id, { ...rest, isCircle, label }];
    }),
  ) as ChatCollection;

  const offsite = migrated.offsite;
  if (!offsite?.isCircle || offsite.memberIds !== undefined) return migrated;

  // Only the bundled demo predates member selection; preserve explicit empty circles.
  const memberIds = LEGACY_OFFSITE_MEMBER_IDS.filter((id) => migrated[id] && !migrated[id].isCircle);
  return { ...migrated, offsite: { ...offsite, memberIds } };
}

export function getCircleMembers(chat: AgentSettings, chats: ChatCollection): Chat[] {
  if (!chat.isCircle) return [];
  return [...new Set(chat.memberIds ?? [])].flatMap((id) => {
    const member = chats[id];
    return member && !member.isCircle ? [member] : [];
  });
}
