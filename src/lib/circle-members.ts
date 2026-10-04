import type { Chat, ChatCollection, ChatSummary, ChatSummaryCollection, WispChat, WispSummary } from "@/chat-data";

const LEGACY_OFFSITE_MEMBER_IDS = ["chief", "inbox", "account"];

type LegacyChat = Chat & { isCircle?: boolean; isGroup?: boolean };

export function migrateLegacyChats(chats: ChatCollection): ChatCollection {
  const legacyOffsite = chats.offsite as LegacyChat | undefined;
  const missingOffsiteMembers =
    legacyOffsite !== undefined && (!("memberIds" in legacyOffsite) || legacyOffsite.memberIds === undefined);
  const migrated = Object.fromEntries(
    Object.entries(chats).map(([id, chat]) => {
      const legacy = chat as LegacyChat;
      const kind = chat.kind ?? (legacy.isCircle || legacy.isGroup ? "circle" : "wisp");
      const systemRole = chat.systemRole ?? (chat.kind === undefined && id === "chief" ? "chief" : undefined);
      const common = {
        id: chat.id,
        name: chat.name,
        label: kind === "circle" && chat.label === "Channel" ? "Circle" : chat.label,
        description: chat.description,
        notifyOnUpdatesEnabled: chat.notifyOnUpdatesEnabled,
        preview: chat.preview,
        timestamp: chat.timestamp,
        messages: chat.messages,
        ...(systemRole ? { systemRole } : {}),
        ...(typeof chat.isActive === "boolean" ? { isActive: chat.isActive } : {}),
        ...(typeof chat.unread === "boolean" ? { unread: chat.unread } : {}),
      };
      if (kind === "circle") {
        const memberIds = "memberIds" in legacy && Array.isArray(legacy.memberIds) ? legacy.memberIds : [];
        return [id, { ...common, kind, memberIds }];
      }
      const wisp = legacy as unknown as WispChat;
      return [
        id,
        {
          ...common,
          kind,
          shape: wisp.shape,
          ...(wisp.color === undefined ? {} : { color: wisp.color }),
          ...(wisp.avatarImage === undefined ? {} : { avatarImage: wisp.avatarImage }),
        },
      ];
    }),
  ) as ChatCollection;

  const offsite = migrated.offsite;
  if (offsite?.kind !== "circle" || !missingOffsiteMembers) return migrated;

  const memberIds = LEGACY_OFFSITE_MEMBER_IDS.filter((id) => migrated[id]?.kind === "wisp");
  return { ...migrated, offsite: { ...offsite, memberIds } };
}

export function getCircleMembers(chat: ChatSummary, chats: ChatSummaryCollection): WispSummary[] {
  if (chat.kind !== "circle") return [];
  return [...new Set(chat.memberIds)].flatMap((id) => {
    const member = chats[id];
    return member?.kind === "wisp" ? [member] : [];
  });
}
