import type { ChatId, CircleSummary, Wisp, WispSummary } from "../shared/conversations";

export type {
  Chat,
  ChatBase,
  ChatChanges,
  ChatCollection,
  ChatId,
  ChatSummary,
  ChatSummaryCollection,
  CircleChat,
  CircleChatChanges,
  CircleSummary,
  Message,
  MessageStatus,
  NewCircle,
  NewWisp,
  Wisp,
  WispChanges,
  WispChat,
  WispChatChanges,
  WispCollection,
  WispId,
  WispSummary,
} from "../shared/conversations";
export type { WispAppearance } from "../shared/wisp-appearance";

/** A Wisp's own conversation, shown with the Wisp. */
export type WispChatView = WispSummary & { wisp: Wisp };
/** A circle, shown with the Wisps in it. */
export type CircleChatView = CircleSummary & { members: ReadonlyArray<Wisp> };
/** A conversation as the app shows it: its summary with the Wisps it involves. */
export type ChatView = WispChatView | CircleChatView;
export type ChatViewCollection = Record<ChatId, ChatView>;

/** What the conversation list's menu does to a conversation. */
export type ChatListAction = "pin" | "unpin" | "mute" | "unmute" | "read" | "unread";
