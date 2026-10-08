import {
  type Chat,
  type ChatChanges,
  type ChatCollection,
  type Message,
  type MessageStatus,
  type ScheduledOrigin,
  type Wisp,
  type WispChanges,
  type WispCollection,
} from "../shared/conversations.js";
import {
  DEFAULT_WISP_APPEARANCE,
  WISP_APPEARANCE_AXES,
  appearanceFromLegacyShape,
  isWispAppearanceValue,
  nearestWispColor,
  wispPaletteColor,
  type WispAppearance,
} from "../shared/wisp-appearance.js";
import { WispBackendError } from "./backend-error.js";
import { CONVERSATION_STORAGE_POLICY } from "./storage-policy.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const MESSAGE_STATUSES = new Set<MessageStatus>(["queued", "streaming", "complete", "failed", "cancelled"]);
// Stored limits. They are looser than the app's form limits because Wisps
// saved by earlier versions were allowed longer names and roles, and a soul
// carries over the tone those versions stored separately.
const MAX_WISP_NAME_LENGTH = 500;
const MAX_WISP_ROLE_LENGTH = 500;
export const MAX_WISP_SOUL_LENGTH = 12_000;

const APPEARANCE_KEYS = Object.keys(WISP_APPEARANCE_AXES) as Array<keyof WispAppearance>;

/**
 * A stored Wisp's appearance. Wisps saved before appearances had a shape, and
 * a value this build does not know (written by a newer one) falls back to the
 * default, so the Wisp still loads.
 */
function storedAppearance(raw: Record<string, unknown>): WispAppearance {
  if (raw.appearance === undefined) {
    const legacy = appearanceFromLegacyShape(raw.shape);
    if (!legacy) throw invalidRequest();
    return legacy;
  }
  const stored = asRecord(raw.appearance);
  const appearance = { ...DEFAULT_WISP_APPEARANCE };
  for (const key of APPEARANCE_KEYS) {
    const value = stored[key];
    if (isWispAppearanceValue(key, value)) (appearance as Record<string, unknown>)[key] = value;
  }
  return appearance;
}

/** An appearance sent in a change, which must be complete and valid. */
function appearanceChange(value: unknown): WispAppearance {
  const raw = asRecord(value);
  if (Object.keys(raw).some((key) => !APPEARANCE_KEYS.includes(key as keyof WispAppearance))) throw invalidRequest();
  const appearance: Partial<Record<keyof WispAppearance, unknown>> = {};
  for (const key of APPEARANCE_KEYS) {
    if (!isWispAppearanceValue(key, raw[key])) throw invalidRequest();
    appearance[key] = raw[key];
  }
  return appearance as WispAppearance;
}

/** A stored color, moved to the closest palette color; one that is not a color is dropped. */
function storedColor(value: unknown): string | undefined {
  return typeof value === "string" ? nearestWispColor(value) : undefined;
}

function colorChange(value: unknown): string {
  const color = typeof value === "string" ? wispPaletteColor(value) : undefined;
  if (!color) throw invalidRequest();
  return color;
}

export function invalidRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The conversation data is invalid.");
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}

export function string(
  value: unknown,
  maxLength: number = CONVERSATION_STORAGE_POLICY.maxTextLength,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw invalidRequest();
  }
  return value;
}

export function timestamp(value: unknown): string {
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

export function normalizeScheduledOrigin(value: unknown): ScheduledOrigin {
  const raw = asRecord(value);
  return {
    scheduledMessageId: normalizeConversationId(raw.scheduledMessageId),
    scheduledAt: timestamp(raw.scheduledAt),
    timeZone: string(raw.timeZone, 64),
  };
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
      ...(raw.authorId === undefined || raw.type !== "incoming"
        ? {}
        : { authorId: normalizeConversationId(raw.authorId) }),
      ...(raw.scheduled === undefined || raw.type !== "outgoing"
        ? {}
        : { scheduled: normalizeScheduledOrigin(raw.scheduled) }),
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

/**
 * Adds or replaces one message by ID. Stored messages were normalized when they
 * were written, so only the incoming message is validated rather than the whole
 * transcript on every append. At the per-conversation limit the oldest messages
 * are dropped: the transcript is display history, and the agent session keeps
 * its own full history.
 */
export function upsertNormalizedMessage(
  chat: Chat,
  value: unknown,
): { chat: Chat; message: Message; droppedOldest: number } {
  const message = normalizeMessage(value);
  if (!message.id) throw invalidRequest();
  const index = chat.messages.findIndex(({ id }) => id === message.id);
  if (index !== -1) {
    const messages = chat.messages.map((candidate, candidateIndex) => (candidateIndex === index ? message : candidate));
    return { chat: { ...chat, messages }, message, droppedOldest: 0 };
  }
  const droppedOldest = Math.max(0, chat.messages.length + 1 - CONVERSATION_STORAGE_POLICY.maxMessagesPerConversation);
  return { chat: { ...chat, messages: [...chat.messages.slice(droppedOldest), message] }, message, droppedOldest };
}

// Stored messages are keyed by (conversation, message ID), so IDs must be
// unique within a chat. Later duplicates from legacy data get fresh short IDs.
function withUniqueMessageIds(messages: ReadonlyArray<Message>): ReadonlyArray<Message> {
  const taken = new Set(messages.flatMap(({ id }) => (id ? [id] : [])));
  const seen = new Set<string>();
  return messages.map((message, index) => {
    if (!message.id || !seen.has(message.id)) {
      if (message.id) seen.add(message.id);
      return message;
    }
    let id = `message-${index}`;
    for (let attempt = 1; taken.has(id); attempt += 1) id = `message-${index}-${attempt}`;
    taken.add(id);
    seen.add(id);
    return { ...message, id };
  });
}

export function normalizeWisp(value: unknown): Wisp {
  const raw = asRecord(value);
  const color = raw.color === undefined ? undefined : storedColor(raw.color);
  return {
    id: normalizeConversationId(raw.id),
    name: string(raw.name, MAX_WISP_NAME_LENGTH, false),
    role: string(raw.role, MAX_WISP_ROLE_LENGTH),
    soul: string(raw.soul, MAX_WISP_SOUL_LENGTH),
    appearance: storedAppearance(raw),
    ...(color === undefined ? {} : { color }),
  };
}

export function normalizeWispChanges(value: unknown): WispChanges {
  const raw = asRecord(value);
  const allowed = new Set(["name", "role", "soul", "appearance", "color"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidRequest();
  const result: WispChanges = {};
  if (raw.name !== undefined) result.name = string(raw.name, MAX_WISP_NAME_LENGTH, false);
  if (raw.role !== undefined) result.role = string(raw.role, MAX_WISP_ROLE_LENGTH);
  if (raw.soul !== undefined) result.soul = string(raw.soul, MAX_WISP_SOUL_LENGTH);
  if (raw.appearance !== undefined) result.appearance = appearanceChange(raw.appearance);
  // Present but undefined clears the color.
  if (Object.hasOwn(raw, "color")) result.color = raw.color === undefined ? undefined : colorChange(raw.color);
  return result;
}

/** Applies validated changes; cleared optional fields are left out rather than kept as undefined. */
export function applyWispChanges(wisp: Wisp, changes: WispChanges): Wisp {
  const next: Wisp = { ...wisp, ...changes };
  if (next.color === undefined) delete next.color;
  return next;
}

export function normalizeChat(value: unknown): Chat {
  const raw = asRecord(value);
  const id = normalizeConversationId(raw.id);
  if (typeof raw.notifyOnUpdatesEnabled !== "boolean") throw invalidRequest();
  if (!Array.isArray(raw.messages) || raw.messages.length > CONVERSATION_STORAGE_POLICY.maxMessagesPerConversation)
    throw invalidRequest();
  const base = {
    id,
    notifyOnUpdatesEnabled: raw.notifyOnUpdatesEnabled,
    preview: string(raw.preview),
    messages: withUniqueMessageIds(
      raw.messages.map((message, index) => normalizeMessage(message, `${id}:message:${index}`)),
    ),
    ...(typeof raw.unread === "boolean" ? { unread: raw.unread } : {}),
    ...(raw.lastActivityAt === undefined ? {} : { lastActivityAt: timestamp(raw.lastActivityAt) }),
  };
  if (raw.kind === "wisp") {
    const wispId = normalizeConversationId(raw.wispId);
    // A Wisp's conversation shares its ID, which keys the Wisp's grants and queues.
    if (wispId !== id) throw invalidRequest();
    return { ...base, kind: "wisp", wispId };
  }
  if (raw.kind !== "circle") throw invalidRequest();
  if (!Array.isArray(raw.memberIds) || raw.memberIds.length > 1_000) throw invalidRequest();
  return {
    ...base,
    kind: "circle",
    name: string(raw.name, 500, false),
    label: string(raw.label, 500),
    description: string(raw.description, 10_000),
    memberIds: raw.memberIds.map(normalizeConversationId),
  };
}

/**
 * Every Wisp has exactly one conversation of its own, and circles list only
 * existing Wisps, each once.
 */
export function validateConversationGraph(chats: Readonly<ChatCollection>, wisps: Readonly<WispCollection>): void {
  for (const wisp of Object.values(wisps)) {
    if (chats[wisp.id]?.kind !== "wisp") throw invalidRequest();
  }
  for (const chat of Object.values(chats)) {
    if (chat.kind === "wisp") {
      if (!wisps[chat.wispId]) throw invalidRequest();
      continue;
    }
    const members = new Set<string>();
    for (const memberId of chat.memberIds) {
      if (members.has(memberId) || !wisps[memberId]) throw invalidRequest();
      members.add(memberId);
    }
  }
}

export function normalizeChatChanges(value: unknown): ChatChanges {
  const raw = asRecord(value);
  if (raw.kind !== "wisp" && raw.kind !== "circle") throw invalidRequest();
  const shared = ["notifyOnUpdatesEnabled", "unread"];
  const allowed = new Set([
    "kind",
    ...shared,
    ...(raw.kind === "circle" ? ["name", "label", "description", "memberIds"] : []),
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidRequest();
  const result: Record<string, unknown> = { kind: raw.kind };
  if (raw.name !== undefined) result.name = string(raw.name, 500, false);
  if (raw.label !== undefined) result.label = string(raw.label, 500);
  if (raw.description !== undefined) result.description = string(raw.description, 10_000);
  if (raw.memberIds !== undefined) {
    if (!Array.isArray(raw.memberIds) || raw.memberIds.length > 1_000) throw invalidRequest();
    result.memberIds = raw.memberIds.map(normalizeConversationId);
  }
  for (const key of ["notifyOnUpdatesEnabled", "unread"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") throw invalidRequest();
      result[key] = raw[key];
    }
  }
  return result as ChatChanges;
}
