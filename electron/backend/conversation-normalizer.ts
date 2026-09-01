import {
  WISP_SHAPE_IDS,
  type AgentSettings,
  type Chat,
  type ChatCollection,
  type Message,
  type MessageStatus,
  type WispShape,
} from "../../shared/conversations.js";
import { WispBackendError } from "./backend-error.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const SHAPES = new Set<WispShape>(WISP_SHAPE_IDS);
const MESSAGE_STATUSES = new Set<MessageStatus>(["queued", "streaming", "complete", "failed", "cancelled"]);
const MAX_MESSAGES = 10_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_AVATAR_LENGTH = 6_000_000;

function invalidRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The conversation data is invalid.");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}

function string(value: unknown, maxLength = MAX_TEXT_LENGTH, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw invalidRequest();
  }
  return value;
}

function timestamp(value: unknown): string {
  const normalized = string(value, 100, false);
  if (Number.isNaN(Date.parse(normalized))) throw invalidRequest();
  return normalized;
}

export function normalizeConversationId(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !ID_PATTERN.test(value)) {
    throw invalidRequest();
  }
  return value;
}

export function normalizeMessage(value: unknown, fallbackId?: string): Message {
  const raw = asRecord(value);
  const id = raw.id === undefined ? fallbackId : normalizeConversationId(raw.id);
  const status = raw.status === undefined ? "complete" : raw.status;
  if (typeof status !== "string" || !MESSAGE_STATUSES.has(status as MessageStatus)) {
    throw invalidRequest();
  }
  if (raw.retryable !== undefined && typeof raw.retryable !== "boolean") throw invalidRequest();
  const metadata = {
    ...(id ? { id } : {}),
    status: status as MessageStatus,
    ...(raw.retryable === undefined ? {} : { retryable: raw.retryable }),
    ...(raw.createdAt === undefined ? {} : { createdAt: timestamp(raw.createdAt) }),
  };

  if (raw.type === "incoming" || raw.type === "outgoing") {
    const reactions = raw.reactions;
    if (reactions !== undefined && (!Array.isArray(reactions) || reactions.length > 100)) {
      throw invalidRequest();
    }
    return {
      ...metadata,
      type: raw.type,
      text: string(raw.text),
      ...(raw.time === undefined ? {} : { time: string(raw.time, 100) }),
      ...(reactions === undefined ? {} : { reactions: reactions.map((item) => string(item, 100)) }),
    };
  }
  if (raw.type === "time") {
    return { ...metadata, type: "time", text: string(raw.text) };
  }
  if (raw.type === "card") {
    if (!Array.isArray(raw.items) || raw.items.length > 100) throw invalidRequest();
    return {
      ...metadata,
      type: "card",
      items: raw.items.map((item) => {
        const record = asRecord(item);
        return { label: string(record.label, 500), text: string(record.text) };
      }),
    };
  }
  if (raw.type === "prompt") {
    if (!Array.isArray(raw.options) || raw.options.length > 100) throw invalidRequest();
    return {
      ...metadata,
      type: "prompt",
      question: string(raw.question),
      options: raw.options.map((option) => {
        const record = asRecord(option);
        return { key: string(record.key, 128, false), label: string(record.label, 500) };
      }),
      ...(raw.answer === undefined ? {} : { answer: string(raw.answer, 128) }),
    };
  }
  throw invalidRequest();
}

export function normalizeChat(value: unknown): Chat {
  const raw = asRecord(value);
  const id = normalizeConversationId(raw.id);
  if (typeof raw.shape !== "string" || !SHAPES.has(raw.shape as WispShape)) throw invalidRequest();
  if (typeof raw.isCircle !== "boolean" || typeof raw.notifyOnUpdatesEnabled !== "boolean") {
    throw invalidRequest();
  }
  if (!Array.isArray(raw.messages) || raw.messages.length > MAX_MESSAGES) throw invalidRequest();
  if (raw.memberIds !== undefined && (!Array.isArray(raw.memberIds) || raw.memberIds.length > 1_000)) {
    throw invalidRequest();
  }

  return {
    id,
    name: string(raw.name, 500, false),
    label: string(raw.label, 500),
    description: string(raw.description, 10_000),
    shape: raw.shape as WispShape,
    isCircle: raw.isCircle,
    notifyOnUpdatesEnabled: raw.notifyOnUpdatesEnabled,
    preview: string(raw.preview),
    timestamp: string(raw.timestamp, 500),
    messages: raw.messages.map((message, index) => normalizeMessage(message, `${id}:message:${index}`)),
    ...(raw.color === undefined ? {} : { color: string(raw.color, 100) }),
    ...(raw.avatarImage === undefined ? {} : { avatarImage: string(raw.avatarImage, MAX_AVATAR_LENGTH) }),
    ...(raw.memberIds === undefined ? {} : { memberIds: raw.memberIds.map(normalizeConversationId) }),
    ...(typeof raw.isActive === "boolean" ? { isActive: raw.isActive } : {}),
    ...(typeof raw.unread === "boolean" ? { unread: raw.unread } : {}),
  };
}

export function normalizeChatCollection(value: unknown): ChatCollection {
  const raw = asRecord(value);
  if (Object.keys(raw).length > 1_000) throw invalidRequest();
  const chats: ChatCollection = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = normalizeConversationId(key);
    const chat = normalizeChat(value);
    if (chat.id !== id) throw invalidRequest();
    chats[id] = chat;
  }
  return chats;
}

export function normalizeAgentSettingsChanges(value: unknown): Partial<Omit<AgentSettings, "id" | "isCircle">> {
  const raw = asRecord(value);
  const allowed = new Set([
    "name",
    "label",
    "description",
    "color",
    "avatarImage",
    "shape",
    "memberIds",
    "notifyOnUpdatesEnabled",
    "isActive",
    "unread",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidRequest();
  const result: Partial<Omit<AgentSettings, "id" | "isCircle">> = {};
  if (raw.name !== undefined) result.name = string(raw.name, 500, false);
  if (raw.label !== undefined) result.label = string(raw.label, 500);
  if (raw.description !== undefined) result.description = string(raw.description, 10_000);
  if (Object.hasOwn(raw, "color")) result.color = raw.color === undefined ? undefined : string(raw.color, 100);
  if (Object.hasOwn(raw, "avatarImage")) {
    result.avatarImage = raw.avatarImage === undefined ? undefined : string(raw.avatarImage, MAX_AVATAR_LENGTH);
  }
  if (raw.shape !== undefined) {
    if (typeof raw.shape !== "string" || !SHAPES.has(raw.shape as WispShape)) throw invalidRequest();
    result.shape = raw.shape as WispShape;
  }
  if (raw.memberIds !== undefined) {
    if (!Array.isArray(raw.memberIds) || raw.memberIds.length > 1_000) throw invalidRequest();
    result.memberIds = raw.memberIds.map(normalizeConversationId);
  }
  for (const key of ["notifyOnUpdatesEnabled", "isActive", "unread"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") throw invalidRequest();
      result[key] = raw[key];
    }
  }
  return result;
}
