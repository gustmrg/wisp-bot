import type { ModelSelection } from "./contracts.js";
import type { ToolApprovalRequest } from "./tool-policy.js";
import type { WispTone } from "./wisp-tone.js";

export type ChatId = string;

export const WISP_SHAPE_IDS = [
  "circle",
  "pebble",
  "square",
  "triangle",
  "diamond",
  "hexagon",
  "cloud",
  "drop",
] as const;

export type WispShape = (typeof WISP_SHAPE_IDS)[number];

export type MessageStatus = "queued" | "streaming" | "complete" | "failed" | "cancelled";

interface MessageMetadata {
  id?: string;
  status?: MessageStatus;
  retryable?: boolean;
  createdAt?: string;
}

export interface ChatBase {
  id: ChatId;
  name: string;
  label: string;
  description: string;
  notifyOnUpdatesEnabled: boolean;
  preview: string;
  timestamp: string;
  messages: ReadonlyArray<Message>;
  systemRole?: "chief";
  isActive?: boolean;
  unread?: boolean;
  /** Time of the newest message (ISO 8601), maintained by the backend. */
  lastActivityAt?: string;
}

export interface WispChat extends ChatBase {
  kind: "wisp";
  color?: string;
  avatarImage?: string;
  shape: WispShape;
  /** Absent when the Wisp uses the default tone. */
  tone?: WispTone;
}

export interface CircleChat extends ChatBase {
  kind: "circle";
  memberIds: ReadonlyArray<ChatId>;
}

export interface TextMessage extends MessageMetadata {
  type: "incoming" | "outgoing";
  text: string;
  time?: string;
  reactions?: ReadonlyArray<string>;
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

type NewChatBase = Pick<ChatBase, "name" | "label" | "description" | "notifyOnUpdatesEnabled">;

export type NewWisp = NewChatBase & Pick<WispChat, "color" | "avatarImage" | "shape" | "tone"> & { kind: "wisp" };
export type NewCircle = NewChatBase & Pick<CircleChat, "memberIds"> & { kind: "circle" };
export type NewChat = NewWisp | NewCircle;

type SharedChatChanges = Partial<
  Pick<ChatBase, "name" | "label" | "description" | "notifyOnUpdatesEnabled" | "isActive" | "unread">
>;

export type WispChatChanges = SharedChatChanges &
  Partial<Pick<WispChat, "color" | "avatarImage" | "shape" | "tone">> & { kind: "wisp" };
export type CircleChatChanges = SharedChatChanges & Partial<Pick<CircleChat, "memberIds">> & { kind: "circle" };
export type ChatChanges = WispChatChanges | CircleChatChanges;

export type ChatCollection = Record<ChatId, Chat>;
export type ChatSummaryCollection = Record<ChatId, ChatSummary>;

export function chatSummary(chat: Chat): ChatSummary {
  const { messages: _messages, ...summary } = chat;
  return summary;
}

export type ManagedConversationStatus = "configuration_required" | "idle" | "working" | "disposed";

export interface ConversationStateView {
  initialized: boolean;
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

export interface CreateConversationRequest {
  conversation: Chat;
  model?: ModelSelection | null;
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
