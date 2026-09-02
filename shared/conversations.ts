import type { ToolApprovalRequest } from "./tool-policy.js";

export type ChatId = string;

export const WISP_SHAPE_IDS = [
  "circle",
  "pebble",
  "square",
  "pill",
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
}

export interface WispChat extends ChatBase {
  kind: "wisp";
  color?: string;
  avatarImage?: string;
  shape: WispShape;
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

type NewChatBase = Pick<ChatBase, "name" | "label" | "description" | "notifyOnUpdatesEnabled">;

export type NewWisp = NewChatBase & Pick<WispChat, "color" | "avatarImage" | "shape"> & { kind: "wisp" };
export type NewCircle = NewChatBase & Pick<CircleChat, "memberIds"> & { kind: "circle" };
export type NewChat = NewWisp | NewCircle;

type SharedChatChanges = Partial<
  Pick<ChatBase, "name" | "label" | "description" | "notifyOnUpdatesEnabled" | "isActive" | "unread">
>;

export type WispChatChanges = SharedChatChanges &
  Partial<Pick<WispChat, "color" | "avatarImage" | "shape">> & { kind: "wisp" };
export type CircleChatChanges = SharedChatChanges & Partial<Pick<CircleChat, "memberIds">> & { kind: "circle" };
export type ChatChanges = WispChatChanges | CircleChatChanges;

export type ChatCollection = Record<ChatId, Chat>;

export type ManagedConversationStatus = "configuration_required" | "idle" | "working" | "disposed";

export interface ConversationStateView {
  initialized: boolean;
  chats: ChatCollection;
  statuses: Record<ChatId, ManagedConversationStatus>;
  agentEventSequence: number;
  pendingToolApprovals: ReadonlyArray<ToolApprovalRequest>;
  recoveredCorruptState: boolean;
}

export interface InitializeConversationsRequest {
  chats: unknown;
}

export interface CreateConversationRequest {
  conversation: Chat;
}

export interface UpdateConversationRequest {
  conversationId: ChatId;
  changes: ChatChanges;
}

export interface DeleteConversationRequest {
  conversationId: ChatId;
}

export interface AppendConversationMessageRequest {
  conversationId: ChatId;
  message: Message;
}

export interface AnswerConversationPromptRequest {
  conversationId: ChatId;
  messageId: string;
  answer: string;
}

export interface MarkConversationReadRequest {
  conversationId: ChatId;
}
