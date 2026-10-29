import {
  type Chat,
  type ChatBase,
  type ChatChanges,
  type ChatCollection,
  type Message,
  type MessageStatus,
  type JobOrigin,
  type MessageFailure,
  MESSAGE_FAILURE_MAX_LENGTH,
  MAX_MESSAGE_STEPS,
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
import type { BackgroundProcessAction, TurnItem, TurnItemStatus } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import { CONVERSATION_STORAGE_POLICY } from "./storage-policy.js";
import { MAX_TURN_ITEM_DIFF_CHARACTERS, MAX_TURN_ITEM_OUTPUT_CHARACTERS } from "./turn-items.js";

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

export function normalizeJobOrigin(value: unknown): JobOrigin {
  const raw = asRecord(value);
  return {
    jobId: normalizeConversationId(raw.jobId),
    runId: normalizeConversationId(raw.runId),
    title: string(raw.title, 200),
  };
}

function normalizeMessageFailure(value: unknown): MessageFailure {
  const raw = asRecord(value);
  return { code: string(raw.code, 64, false), message: string(raw.message, MESSAGE_FAILURE_MAX_LENGTH, false) };
}

const TURN_ITEM_STATUSES = new Set<string>(["running", "completed", "failed", "cancelled"]);
const PROCESS_ACTIONS = new Set<string>(["start", "list", "log", "wait", "kill"]);
const STEP_FIELD_LENGTH = 2_000;
// Some room over what the backend writes, so a step it wrote always loads.
const STEP_OUTPUT_LENGTH = MAX_TURN_ITEM_OUTPUT_CHARACTERS * 2;
const STEP_DIFF_LENGTH = MAX_TURN_ITEM_DIFF_CHARACTERS * 2;

/**
 * A reply's steps. A step that does not load is left out rather than failing
 * the message, and a kind this version does not know shows as a plain tool
 * call, so steps written by a newer version still load.
 */
function normalizeSteps(value: unknown): { steps?: TurnItem[] } {
  if (!Array.isArray(value)) return {};
  const steps = value.slice(-MAX_MESSAGE_STEPS).flatMap((item) => {
    try {
      return [normalizeTurnItem(item)];
    } catch {
      return [];
    }
  });
  return steps.length ? { steps } : {};
}

function normalizeTurnItem(value: unknown): TurnItem {
  const raw = asRecord(value);
  if (typeof raw.status !== "string" || !TURN_ITEM_STATUSES.has(raw.status)) throw invalidRequest();
  const optional = (key: string, maxLength = STEP_FIELD_LENGTH) =>
    raw[key] === undefined ? {} : { [key]: string(raw[key], maxLength) };
  const flag = (key: string) => (raw[key] === true ? { [key]: true } : {});
  const count = (key: string) =>
    Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0 ? { [key]: raw[key] as number } : {};
  const base = {
    id: normalizeConversationId(raw.id),
    toolName: string(raw.toolName, 200, false),
    status: raw.status as TurnItemStatus,
    startedAt: timestamp(raw.startedAt),
    ...(raw.completedAt === undefined ? {} : { completedAt: timestamp(raw.completedAt) }),
    ...optional("label", 200),
  };
  switch (raw.type) {
    case "command_execution":
      return {
        ...base,
        type: "command_execution",
        command: string(raw.command, STEP_FIELD_LENGTH),
        ...optional("purpose", 200),
        ...(Number.isSafeInteger(raw.exitCode) ? { exitCode: raw.exitCode as number } : {}),
        ...optional("output", STEP_OUTPUT_LENGTH),
        ...flag("outputTruncated"),
      };
    case "background_process":
      if (typeof raw.action !== "string" || !PROCESS_ACTIONS.has(raw.action)) throw invalidRequest();
      return {
        ...base,
        type: "background_process",
        action: raw.action as BackgroundProcessAction,
        ...optional("processId", 64),
        ...optional("command"),
        ...optional("state", 64),
        ...optional("output", STEP_OUTPUT_LENGTH),
        ...flag("outputTruncated"),
      };
    case "file_change":
      return {
        ...base,
        type: "file_change",
        path: string(raw.path, STEP_FIELD_LENGTH),
        ...count("additions"),
        ...count("deletions"),
        ...optional("diff", STEP_DIFF_LENGTH),
        ...flag("diffTruncated"),
      };
    case "file_read":
      if (!Array.isArray(raw.paths) || raw.paths.length > 100) throw invalidRequest();
      return { ...base, type: "file_read", paths: raw.paths.map((path) => string(path, STEP_FIELD_LENGTH)) };
    case "file_search":
      return { ...base, type: "file_search", pattern: string(raw.pattern, STEP_FIELD_LENGTH), ...optional("path") };
    case "web_search":
      return { ...base, type: "web_search", query: string(raw.query, STEP_FIELD_LENGTH) };
    case "web_read":
      return { ...base, type: "web_read", url: string(raw.url, STEP_FIELD_LENGTH) };
    case "browser":
      return {
        ...base,
        type: "browser",
        action: string(raw.action, 40),
        ...optional("url"),
        ...optional("pageTitle", 400),
      };
    default:
      return { ...base, type: "tool" };
  }
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
      ...(raw.authorName === undefined || raw.type !== "incoming" ? {} : { authorName: string(raw.authorName, 256) }),
      ...(raw.scheduled === undefined || raw.type !== "outgoing"
        ? {}
        : { scheduled: normalizeScheduledOrigin(raw.scheduled) }),
      ...(raw.job === undefined || raw.type !== "incoming" ? {} : { job: normalizeJobOrigin(raw.job) }),
      ...(raw.fallbackModel === undefined || raw.type !== "incoming"
        ? {}
        : { fallbackModel: string(raw.fallbackModel, 256, false) }),
      ...(raw.error === undefined || raw.type !== "incoming" ? {} : { error: normalizeMessageFailure(raw.error) }),
      ...(raw.steps === undefined || raw.type !== "incoming" ? {} : normalizeSteps(raw.steps)),
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
    ...(raw.memoryOff === true ? { memoryOff: true } : {}),
  };
}

export function normalizeWispChanges(value: unknown): WispChanges {
  const raw = asRecord(value);
  const allowed = new Set(["name", "role", "soul", "appearance", "color", "memoryOff"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw invalidRequest();
  const result: WispChanges = {};
  if (raw.name !== undefined) result.name = string(raw.name, MAX_WISP_NAME_LENGTH, false);
  if (raw.role !== undefined) result.role = string(raw.role, MAX_WISP_ROLE_LENGTH);
  if (raw.soul !== undefined) result.soul = string(raw.soul, MAX_WISP_SOUL_LENGTH);
  if (raw.appearance !== undefined) result.appearance = appearanceChange(raw.appearance);
  // Present but undefined clears the color.
  if (Object.hasOwn(raw, "color")) result.color = raw.color === undefined ? undefined : colorChange(raw.color);
  if (raw.memoryOff !== undefined) {
    if (typeof raw.memoryOff !== "boolean") throw invalidRequest();
    result.memoryOff = raw.memoryOff;
  }
  return result;
}

/** Applies validated changes; cleared optional fields are left out rather than kept as undefined. */
export function applyWispChanges(wisp: Wisp, changes: WispChanges): Wisp {
  const next: Wisp = { ...wisp, ...changes };
  if (next.color === undefined) delete next.color;
  if (!next.memoryOff) delete next.memoryOff;
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
    ...unreadFields(raw),
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(raw.lastActivityAt === undefined ? {} : { lastActivityAt: timestamp(raw.lastActivityAt) }),
    ...(raw.createdAt === undefined ? {} : { createdAt: timestamp(raw.createdAt) }),
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
 * `unread` and `unreadCount` always agree. A change that sets only `unread`,
 * from a client that predates the count, decides between none and at least one.
 */
function unreadFields(raw: Record<string, unknown>): Pick<ChatBase, "unread" | "unreadCount"> {
  if (raw.unreadCount !== undefined && !(Number.isSafeInteger(raw.unreadCount) && Number(raw.unreadCount) >= 0)) {
    throw invalidRequest();
  }
  const count = raw.unreadCount as number | undefined;
  if (typeof raw.unread !== "boolean") return count === undefined ? {} : { unread: count > 0, unreadCount: count };
  const unreadCount = raw.unread ? Math.max(1, count ?? 1) : 0;
  return { unread: unreadCount > 0, unreadCount };
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
  const shared = ["notifyOnUpdatesEnabled", "unread", "pinned"];
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
  for (const key of ["notifyOnUpdatesEnabled", "unread", "pinned"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") throw invalidRequest();
      result[key] = raw[key];
    }
  }
  return result as ChatChanges;
}
