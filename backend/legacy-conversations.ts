import type { Chat, Message, Wisp } from "../shared/conversations.js";
import {
  asRecord,
  invalidRequest,
  MAX_WISP_SOUL_LENGTH,
  normalizeChat,
  normalizeConversationId,
  normalizeWisp,
} from "./conversation-normalizer.js";

/**
 * Reads conversations saved before Wisps were stored apart from them: by
 * store layout 3 and earlier, the legacy JSON store, and the renderer's old
 * local storage. Then a Wisp was a conversation that carried its own name,
 * label, description, appearance, and tone.
 */
export interface LegacyChat {
  chat: Chat;
  /** The Wisp a legacy Wisp conversation described; absent for circles. */
  wisp?: Wisp;
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

// The instructions earlier versions sent for each tone, kept so a Wisp keeps
// sounding the same once its tone becomes part of its soul.
const TONE_STYLES: Record<string, string> = {
  friendly: "Warm and approachable. Be encouraging while staying clear and accurate.",
  direct: "Straight to the point. Lead with the answer or recommendation and skip pleasantries and filler.",
  formal: "Professional and polished. Use complete sentences and avoid slang, jokes, and emoji.",
  casual: "Relaxed and conversational, like a knowledgeable colleague. Light humor is fine when it fits.",
  didactic: "A patient teacher. Explain the reasoning behind answers, define terms, and use examples.",
};

const RESPONSE_LENGTHS: Record<string, string> = {
  short: "Keep responses brief: a few sentences or a short list. Expand only when asked.",
  balanced: "Give enough detail to be useful without padding. Go deeper on complex topics.",
  detailed: "Give thorough responses with context, trade-offs, and examples when they help.",
};

export function splitLegacyChat(value: unknown): LegacyChat {
  const raw = asRecord(value);
  const id = normalizeConversationId(raw.id);
  const kind = raw.kind ?? (raw.isCircle === true || raw.isGroup === true ? "circle" : "wisp");
  if (kind !== "wisp" && kind !== "circle") throw invalidRequest();
  if (!Array.isArray(raw.messages)) throw invalidRequest();
  // Stored by the SQLite store; the JSON store had only the display timestamp.
  const lastActivityAt =
    isoTimestamp(raw.lastActivityAt) ?? newestCreatedAt(raw.messages) ?? isoTimestamp(raw.timestamp);
  const common = {
    id,
    notifyOnUpdatesEnabled: raw.notifyOnUpdatesEnabled,
    preview: raw.preview,
    messages: raw.messages,
    ...(typeof raw.unread === "boolean" ? { unread: raw.unread } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
  if (kind === "circle") {
    return {
      chat: normalizeChat({
        ...common,
        kind,
        name: raw.name,
        label: raw.label,
        description: raw.description,
        memberIds: raw.memberIds ?? [],
      }),
    };
  }
  const wisp = normalizeWisp({
    id,
    name: raw.name,
    role: raw.label,
    soul: soulOf(raw.description, raw.tone),
    shape: raw.shape,
    ...(raw.color === undefined ? {} : { color: raw.color }),
    ...(raw.avatarImage === undefined ? {} : { avatarImage: raw.avatarImage }),
  });
  return { wisp, chat: normalizeChat({ ...common, kind, wispId: id }) };
}

/** The description, followed by what the tone asked for, in words the Wisp's soul can hold. */
function soulOf(description: unknown, tone: unknown): unknown {
  if (typeof description !== "string") return description;
  const sections = toneSections(tone);
  if (!sections.length) return description;
  const soul = [description.trim(), ...sections].filter(Boolean).join("\n\n");
  return soul.length > MAX_WISP_SOUL_LENGTH ? description : soul;
}

function toneSections(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const { style, length, custom } = value as Record<string, unknown>;
  const styleText = style === "custom" && typeof custom === "string" ? custom.trim() : TONE_STYLES[String(style)];
  const lengthText = RESPONSE_LENGTHS[String(length)];
  return [
    ...(styleText ? [`## Tone\n${styleText}`] : []),
    ...(lengthText ? [`## Response length\n${lengthText}`] : []),
  ];
}

function newestCreatedAt(messages: ReadonlyArray<unknown>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const createdAt = (messages[index] as Partial<Message> | null)?.createdAt;
    if (typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt))) return createdAt;
  }
  return undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}
