export type ChatId = string;

export type WispShape =
  | "circle"
  | "pebble"
  | "triangle"
  | "cloud"
  | "square"
  | "pill"
  | "diamond"
  | "hexagon"
  | "drop";

export type MessageStatus = "queued" | "streaming" | "complete" | "failed" | "cancelled";

interface MessageMetadata {
  id?: string;
  status?: MessageStatus;
  retryable?: boolean;
}

export interface AgentSettings {
  id: string;
  name: string;
  label: string;
  description: string;
  color?: string;
  avatarImage?: string;
  shape: WispShape;
  isCircle: boolean;
  memberIds?: ChatId[];
  notifyOnUpdatesEnabled: boolean;
  isActive?: boolean;
  unread?: boolean;
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

export interface Chat extends AgentSettings {
  preview: string;
  timestamp: string;
  messages: ReadonlyArray<Message>;
}

export type ChatCollection = Record<ChatId, Chat>;

export type ManagedConversationStatus =
  | "configuration_required"
  | "idle"
  | "working"
  | "disposed";

export interface ConversationStateView {
  initialized: boolean;
  chats: ChatCollection;
  statuses: Record<ChatId, ManagedConversationStatus>;
  agentEventSequence: number;
  recoveredCorruptState: boolean;
}

export interface InitializeConversationsRequest {
  chats: ChatCollection;
}

export interface CreateConversationRequest {
  conversation: Chat;
}

export interface UpdateConversationRequest {
  conversationId: ChatId;
  changes: Partial<Omit<AgentSettings, "id" | "isCircle">>;
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
