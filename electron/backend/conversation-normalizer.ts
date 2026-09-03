import {
  WISP_SHAPE_IDS,
  type Chat,
  type ChatChanges,
  type ChatCollection,
  type Message,
  type MessageStatus,
  type WispShape,
} from "../../shared/conversations.js";
import { WispBackendError } from "./backend-error.js";
import { CONVERSATION_STORAGE_POLICY, WEBP_DATA_URL_PREFIX } from "./storage-policy.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const SHAPES = new Set<WispShape>(WISP_SHAPE_IDS);
const MESSAGE_STATUSES = new Set<MessageStatus>(["queued", "streaming", "complete", "failed", "cancelled"]);
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The conversation data is invalid.");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  maxLength: number = CONVERSATION_STORAGE_POLICY.maxTextLength,
  allowEmpty = true,
): string {
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

function avatarDataUrl(value: unknown): string {
  const normalized = string(value, CONVERSATION_STORAGE_POLICY.maxAvatarDataUrlLength, false);
  if (!normalized.startsWith(WEBP_DATA_URL_PREFIX)) throw invalidRequest();
  const payload = normalized.slice(WEBP_DATA_URL_PREFIX.length);
  if (!payload || !BASE64_PATTERN.test(payload)) throw invalidRequest();
  return normalized;
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
  const legacyKind = raw.isCircle === true || raw.isGroup === true ? "circle" : "wisp";
  const kind = raw.kind === undefined ? legacyKind : raw.kind;
  if (kind !== "wisp" && kind !== "circle") throw invalidRequest();
  if (raw.systemRole !== undefined && raw.systemRole !== "chief") throw invalidRequest();
  if (typeof raw.notifyOnUpdatesEnabled !== "boolean") throw invalidRequest();
  if (!Array.isArray(raw.messages) || raw.messages.length > CONVERSATION_STORAGE_POLICY.maxMessagesPerConversation)
    throw invalidRequest();
  const base = {
    id,
    name: string(raw.name, 500, false),
    label: string(raw.label, 500),
    description: string(raw.description, 10_000),
    notifyOnUpdatesEnabled: raw.notifyOnUpdatesEnabled,
    preview: string(raw.preview),
    timestamp: string(raw.timestamp, 500),
    messages: raw.messages.map((message, index) => normalizeMessage(message, `${id}:message:${index}`)),
    ...(raw.systemRole === "chief" || (raw.kind === undefined && id === "chief")
      ? { systemRole: "chief" as const }
      : {}),
    ...(typeof raw.isActive === "boolean" ? { isActive: raw.isActive } : {}),
    ...(typeof raw.unread === "boolean" ? { unread: raw.unread } : {}),
  };
  if (kind === "circle") {
    if (
      raw.kind !== undefined &&
      (raw.shape !== undefined || raw.color !== undefined || raw.avatarImage !== undefined)
    ) {
      throw invalidRequest();
    }
    if (raw.memberIds !== undefined && (!Array.isArray(raw.memberIds) || raw.memberIds.length > 1_000)) {
      throw invalidRequest();
    }
    return {
      ...base,
      kind,
      memberIds: raw.memberIds === undefined ? [] : raw.memberIds.map(normalizeConversationId),
    };
  }
  if (raw.kind !== undefined && raw.memberIds !== undefined) throw invalidRequest();
  if (typeof raw.shape !== "string" || !SHAPES.has(raw.shape as WispShape)) throw invalidRequest();
  return {
    ...base,
    kind,
    shape: raw.shape as WispShape,
    ...(raw.color === undefined ? {} : { color: string(raw.color, 100) }),
    ...(raw.avatarImage === undefined ? {} : { avatarImage: avatarDataUrl(raw.avatarImage) }),
  };
}

export function normalizeChatCollection(value: unknown): ChatCollection {
  const raw = asRecord(value);
  if (Object.keys(raw).length > CONVERSATION_STORAGE_POLICY.maxConversations) throw invalidRequest();
  const chats: ChatCollection = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = normalizeConversationId(key);
    const chat = normalizeChat(value);
    if (chat.id !== id) throw invalidRequest();
    chats[id] = chat;
  }
  validateConversationGraph(chats);
  return chats;
}

export function validateConversationGraph(chats: Readonly<ChatCollection>): void {
  for (const chat of Object.values(chats)) {
    if (chat.kind !== "circle") continue;
    const members = new Set<string>();
    for (const memberId of chat.memberIds) {
      if (members.has(memberId) || chats[memberId]?.kind !== "wisp") throw invalidRequest();
      members.add(memberId);
    }
  }
}

export function normalizeChatChanges(value: unknown): ChatChanges {
  const raw = asRecord(value);
  if (raw.kind !== "wisp" && raw.kind !== "circle") throw invalidRequest();
  const shared = ["name", "label", "description", "notifyOnUpdatesEnabled", "isActive", "unread"];
  const allowed = new Set([
    "kind",
    ...shared,
    ...(raw.kind === "wisp" ? ["color", "avatarImage", "shape"] : ["memberIds"]),
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidRequest();
  const result: Record<string, unknown> = { kind: raw.kind };
  if (raw.name !== undefined) result.name = string(raw.name, 500, false);
  if (raw.label !== undefined) result.label = string(raw.label, 500);
  if (raw.description !== undefined) result.description = string(raw.description, 10_000);
  if (Object.hasOwn(raw, "color")) result.color = raw.color === undefined ? undefined : string(raw.color, 100);
  if (Object.hasOwn(raw, "avatarImage")) {
    result.avatarImage = raw.avatarImage === undefined ? undefined : avatarDataUrl(raw.avatarImage);
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
  return result as ChatChanges;
}
