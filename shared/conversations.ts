import type { ModelSelection } from "./contracts.js";
import type { ToolApprovalRequest } from "./tool-policy.js";
import type { WispAppearance } from "./wisp-appearance.js";

export type ChatId = string;
export type WispId = string;

export const WISP_NAME_MAX_LENGTH = 64;
export const WISP_ROLE_MAX_LENGTH = 40;
export const WISP_SOUL_MAX_LENGTH = 10_000;

/**
 * A Wisp: who it is, independent of the conversations it takes part in. The
 * same Wisp talks with the person in its own conversation and can join
 * circles with other Wisps.
 */
export interface Wisp {
  id: WispId;
  name: string;
  /** A short role or profession shown under the name, such as "Research". */
  role: string;
  /** Markdown that defines the Wisp's identity, personality, and behavior. */
  soul: string;
  /** How the Wisp is drawn. */
  appearance: WispAppearance;
  /** One of `WISP_COLORS`; without one, the color is derived from the name. */
  color?: string;
}

export type WispCollection = Record<WispId, Wisp>;

export type NewWisp = Omit<Wisp, "id">;
/** Fields to change; `color` set to undefined is cleared. */
export type WispChanges = Partial<NewWisp>;

export type MessageStatus = "queued" | "streaming" | "complete" | "failed" | "cancelled";

interface MessageMetadata {
  id?: string;
  status?: MessageStatus;
  retryable?: boolean;
  createdAt?: string;
}

export interface ChatBase {
  id: ChatId;
  notifyOnUpdatesEnabled: boolean;
  preview: string;
  messages: ReadonlyArray<Message>;
  /** Whether any messages are unread; kept beside `unreadCount` for older clients. */
  unread?: boolean;
  /** Replies and questions from Wisps since the person last read the conversation. */
  unreadCount?: number;
  /** Pinned conversations come first in the list, on every device. */
  pinned?: boolean;
  /** Time of the newest message (ISO 8601), maintained by the backend. */
  lastActivityAt?: string;
}

/** The conversation between the person and one Wisp. It shares the Wisp's ID. */
export interface WispChat extends ChatBase {
  kind: "wisp";
  wispId: WispId;
}

/** A conversation between the person and several Wisps. */
export interface CircleChat extends ChatBase {
  kind: "circle";
  name: string;
  label: string;
  description: string;
  memberIds: ReadonlyArray<WispId>;
}

/** Where a message the backend sent on the person's behalf came from. */
export interface ScheduledOrigin {
  scheduledMessageId: string;
  /** When the person scheduled it (ISO 8601). */
  scheduledAt: string;
  /** The IANA time zone they scheduled it in. */
  timeZone: string;
}

export interface TextMessage extends MessageMetadata {
  type: "incoming" | "outgoing";
  text: string;
  time?: string;
  reactions?: ReadonlyArray<string>;
  /**
   * The Wisp that wrote an incoming message. Absent on messages written
   * before Wisps were stored apart from conversations, which in a Wisp's own
   * conversation are its own.
   */
  authorId?: WispId;
  /** Set on an outgoing message sent from a scheduled message rather than typed then. */
  scheduled?: ScheduledOrigin;
}

export interface TimeMessage extends MessageMetadata {
  type: "time";
  text: string;
}

export interface CardMessage extends MessageMetadata {
  type: "card";
  items: ReadonlyArray<{ label: string; text: string }>;
}

export interface PromptMessage extends MessageMetadata {
  type: "prompt";
  question: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  answer?: string;
}

export type Message = TextMessage | TimeMessage | CardMessage | PromptMessage;

export type Chat = WispChat | CircleChat;

/** A conversation without its transcript: what lists, headers, and settings show. */
export type WispSummary = Omit<WispChat, "messages">;
export type CircleSummary = Omit<CircleChat, "messages">;
export type ChatSummary = WispSummary | CircleSummary;

export type NewCircle = Pick<CircleChat, "name" | "label" | "description" | "notifyOnUpdatesEnabled" | "memberIds"> & {
  kind: "circle";
};

type SharedChatChanges = Partial<Pick<ChatBase, "notifyOnUpdatesEnabled" | "unread" | "pinned">>;

export type WispChatChanges = SharedChatChanges & { kind: "wisp" };
export type CircleChatChanges = SharedChatChanges &
  Partial<Pick<CircleChat, "name" | "label" | "description" | "memberIds">> & { kind: "circle" };
export type ChatChanges = WispChatChanges | CircleChatChanges;

export type ChatCollection = Record<ChatId, Chat>;
export type ChatSummaryCollection = Record<ChatId, ChatSummary>;

/**
 * A reply to a request can span several messages: text the Wisp writes before
 * using a tool ("Let me look that up") is its own message, and the reply that
 * follows is the next part. The first part keeps the original ID.
 */
export function assistantMessageId(requestId: string, part = 1): string {
  return part === 1 ? `${requestId}:assistant` : `${requestId}:assistant:${part}`;
}

/** The request a reply message answers, or null for any other message. */
export function requestIdOfAssistantMessage(messageId: string): string | null {
  return /^(.+):assistant(?::\d+)?$/.exec(messageId)?.[1] ?? null;
}

export function chatSummary(chat: Chat): ChatSummary {
  const { messages: _messages, ...summary } = chat;
  return summary;
}

export type ManagedConversationStatus = "configuration_required" | "idle" | "working" | "disposed";

export interface ConversationStateView {
  initialized: boolean;
  wisps: WispCollection;
  chats: ChatCollection;
  statuses: Record<ChatId, ManagedConversationStatus>;
  /**
   * Messages that are not stored yet: replies still streaming or being saved.
   * They are as of `agentEventSequence`, so later events apply on top of them.
   */
  liveMessages: Record<ChatId, ReadonlyArray<Message>>;
  agentEventSequence: number;
  pendingToolApprovals: ReadonlyArray<ToolApprovalRequest>;
  recoveredCorruptState: boolean;
}

/**
 * One conversation's change: its summary and the messages the change touched,
 * as stored. A renderer applies it to the message window it holds, if any.
 */
export interface ConversationDelta {
  chat: ChatSummary;
  /** New messages at the end of the transcript, oldest first. */
  added: ReadonlyArray<Message>;
  /** Earlier messages whose content changed; each keeps its position. */
  updated: ReadonlyArray<Message>;
}

export interface InitializeConversationsRequest {
  chats: unknown;
}

/** Creates a circle; a Wisp's own conversation is created with the Wisp. */
export interface CreateConversationRequest {
  conversation: CircleChat;
}

/** Creates a Wisp and its conversation, which shares the Wisp's ID. */
export interface CreateWispRequest {
  wisp: Wisp;
  notifyOnUpdatesEnabled: boolean;
  model?: ModelSelection | null;
}

export interface UpdateWispRequest {
  wispId: WispId;
  changes: WispChanges;
}

/** Deletes a Wisp with its conversation, and removes it from every circle. */
export interface DeleteWispRequest {
  wispId: WispId;
}

export interface UpdateConversationRequest {
  conversationId: ChatId;
  changes: ChatChanges;
}

export interface DeleteConversationRequest {
  conversationId: ChatId;
}

/** A message the user wrote; replies and notices are written only by the backend. */
export type OutgoingMessage = TextMessage & { type: "outgoing" };

export interface AppendConversationMessageRequest {
  conversationId: ChatId;
  message: OutgoingMessage;
}

export interface AnswerConversationPromptRequest {
  conversationId: ChatId;
  messageId: string;
  answer: string;
}

export interface MarkConversationReadRequest {
  conversationId: ChatId;
}

export type MarkConversationUnreadRequest = MarkConversationReadRequest;

/**
 * Which slice of a transcript to read. Cursors are opaque; they come from a
 * previous `MessagePage`.
 */
export type MessagePageRequest =
  | { conversationId: ChatId; page: "latest" }
  | { conversationId: ChatId; page: "older" | "newer"; cursor: string }
  | { conversationId: ChatId; page: "around"; messageId: string };

export interface MessagePage {
  /** Oldest first. */
  messages: ReadonlyArray<Message>;
  /** Reads the messages before this page; null when the page starts at the first message. */
  olderCursor: string | null;
  /** Reads the messages after this page; null when the page reaches the newest message. */
  newerCursor: string | null;
}

export interface SearchMessagesRequest {
  query: string;
}

export interface MessageSearchHit {
  conversationId: ChatId;
  messageId: string;
  snippet: string;
  createdAt?: string;
}
