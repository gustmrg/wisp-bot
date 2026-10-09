import { isContextPolicy, type ContextRequest } from "../shared/context-policy.js";
import type {
  UsageReportRequest,
  ApplyModelRequest,
  ConversationRequest,
  ModelSelection,
  RemoveProviderCredentialRequest,
  SaveAiSettingsRequest,
  SendMessageRequest,
} from "../shared/contracts.js";
import type {
  AnswerConversationPromptRequest,
  AppendConversationMessageRequest,
  CircleChat,
  CreateConversationRequest,
  CreateWispRequest,
  DeleteConversationRequest,
  DeleteWispRequest,
  InitializeConversationsRequest,
  MarkConversationReadRequest,
  MessagePageRequest,
  SearchMessagesRequest,
  UpdateConversationRequest,
  UpdateWispRequest,
} from "../shared/conversations.js";
import { MAX_MESSAGE_SEARCH_LENGTH, MIN_MESSAGE_SEARCH_LENGTH } from "../shared/message-search.js";
import { isValidSkillName, type ImportSkillRequest, type SkillRequest } from "../shared/skills.js";
import type { ResolveToolApprovalRequest } from "../shared/tool-policy.js";
import {
  isVoiceLanguage,
  isVoiceModel,
  isVoiceProviderId,
  MAX_VOICE_AUDIO_BYTES,
  VOICE_AUDIO_MIME_TYPES,
  type SaveVoiceCredentialRequest,
  type TranscribeAudioRequest,
  type VoiceAudioMimeType,
} from "../shared/voice.js";
import type { QueuedMessageRequest, QueueMessageRequest, UpdateQueuedMessageRequest } from "../shared/message-queue.js";
import type {
  ScheduledMessageRequest,
  ScheduleMessageRequest,
  UpdateScheduledMessageRequest,
} from "../shared/scheduled-messages.js";
import { WispBackendError } from "./backend-error.js";
import { MAX_SKILL_FILE_BYTES } from "./skill-store.js";
import {
  normalizeChatChanges,
  normalizeChat,
  normalizeMessage,
  normalizeWisp,
  normalizeWispChanges,
} from "./conversation-normalizer.js";
import { isTimeZone, normalizeMessageSchedule } from "./message-schedule.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 32_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest();
  }
  return value as Record<string, unknown>;
}

function parseId(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !ID_PATTERN.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function parseCatalogId(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^[a-zA-Z0-9~][a-zA-Z0-9._:/@~-]*$/.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function invalidRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The backend request is invalid.");
}

export function parseSkillRequest(value: unknown): SkillRequest {
  const request = asRecord(value);
  if (!isValidSkillName(request.name)) throw invalidRequest();
  return { conversationId: parseId(request.conversationId), name: request.name };
}

/** Contents are checked as a skill by `parseSkillDocument`; this only bounds the request. */
export function parseImportSkillRequest(value: unknown): ImportSkillRequest {
  const request = asRecord(value);
  if (typeof request.contents !== "string" || request.contents.length > MAX_SKILL_FILE_BYTES) throw invalidRequest();
  if (request.replace !== undefined && typeof request.replace !== "boolean") throw invalidRequest();
  return {
    conversationId: parseId(request.conversationId),
    contents: request.contents,
    ...(request.replace ? { replace: true } : {}),
  };
}

export function parseConversationRequest(value: unknown): ConversationRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId) };
}

export function parseSendMessageRequest(value: unknown): SendMessageRequest {
  const request = asRecord(value);
  const text = request.text;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_MESSAGE_LENGTH) {
    throw invalidRequest();
  }
  return {
    conversationId: parseId(request.conversationId),
    requestId: parseId(request.requestId),
    text,
  };
}

function parseModelSelection(value: unknown): ModelSelection {
  const model = asRecord(value);
  const maxOutputTokens = model.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(maxOutputTokens) ||
      (maxOutputTokens as number) < 1 ||
      (maxOutputTokens as number) > 1_000_000)
  ) {
    throw invalidRequest();
  }
  return {
    providerId: parseId(model.providerId),
    modelId: parseCatalogId(model.modelId),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: maxOutputTokens as number }),
  };
}

export function parseSaveAiSettingsRequest(value: unknown): SaveAiSettingsRequest {
  const request = asRecord(value);
  const apiKey = request.apiKey;
  if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 20_000)) {
    throw invalidRequest();
  }
  return {
    selection: parseModelSelection(request.selection),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export function parseRemoveProviderCredentialRequest(value: unknown): RemoveProviderCredentialRequest {
  const request = asRecord(value);
  return { providerId: parseId(request.providerId) };
}

export function parseApplyModelRequest(value: unknown): ApplyModelRequest {
  const request = asRecord(value);
  return {
    conversationId: parseId(request.conversationId),
    model: request.model === null ? null : parseModelSelection(request.model),
  };
}

/** The chats arrive in the app's old local-storage format; the repository reads them. */
export function parseInitializeConversationsRequest(value: unknown): InitializeConversationsRequest {
  const request = asRecord(value);
  return { chats: asRecord(request.chats) };
}

export function parseCreateConversationRequest(value: unknown): CreateConversationRequest {
  const request = asRecord(value);
  const conversation = normalizeChat(request.conversation);
  if (conversation.kind !== "circle") throw invalidRequest();
  return { conversation: conversation satisfies CircleChat };
}

export function parseCreateWispRequest(value: unknown): CreateWispRequest {
  const request = asRecord(value);
  const model = request.model;
  if (typeof request.notifyOnUpdatesEnabled !== "boolean") throw invalidRequest();
  return {
    wisp: normalizeWisp(request.wisp),
    notifyOnUpdatesEnabled: request.notifyOnUpdatesEnabled,
    ...(model === undefined || model === null ? { model: null } : { model: parseModelSelection(model) }),
  };
}

export function parseUpdateWispRequest(value: unknown): UpdateWispRequest {
  const request = asRecord(value);
  return { wispId: parseId(request.wispId), changes: normalizeWispChanges(request.changes) };
}

export function parseDeleteWispRequest(value: unknown): DeleteWispRequest {
  const request = asRecord(value);
  return { wispId: parseId(request.wispId) };
}

export function parseUpdateConversationRequest(value: unknown): UpdateConversationRequest {
  const request = asRecord(value);
  return {
    conversationId: parseId(request.conversationId),
    changes: normalizeChatChanges(request.changes),
  };
}

export function parseDeleteConversationRequest(value: unknown): DeleteConversationRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId) };
}

export function parseAppendConversationMessageRequest(value: unknown): AppendConversationMessageRequest {
  const request = asRecord(value);
  const message = normalizeMessage(request.message);
  // The renderer saves only what the user wrote; replies and notices come from the backend.
  if (message.type !== "outgoing") throw invalidRequest();
  return { conversationId: parseId(request.conversationId), message: { ...message, type: "outgoing" } };
}

const CURSOR_PATTERN = /^\d{1,15}$/;

export function parseMessagePageRequest(value: unknown): MessagePageRequest {
  const request = asRecord(value);
  const conversationId = parseId(request.conversationId);
  const keys = Object.keys(request);
  const only = (...allowed: string[]): void => {
    if (keys.some((key) => !["conversationId", "page", ...allowed].includes(key))) throw invalidRequest();
  };
  switch (request.page) {
    case "latest":
      only();
      return { conversationId, page: "latest" };
    case "older":
    case "newer": {
      only("cursor");
      if (typeof request.cursor !== "string" || !CURSOR_PATTERN.test(request.cursor)) throw invalidRequest();
      return { conversationId, page: request.page, cursor: request.cursor };
    }
    case "around":
      only("messageId");
      return { conversationId, page: "around", messageId: parseId(request.messageId) };
    default:
      throw invalidRequest();
  }
}

export function parseSearchMessagesRequest(value: unknown): SearchMessagesRequest {
  const { query } = asRecord(value);
  if (typeof query !== "string") throw invalidRequest();
  const trimmed = query.trim();
  if (Array.from(trimmed).length < MIN_MESSAGE_SEARCH_LENGTH) {
    throw new WispBackendError(
      "invalid_request",
      `Message search needs at least ${MIN_MESSAGE_SEARCH_LENGTH} characters.`,
    );
  }
  if (trimmed.length > MAX_MESSAGE_SEARCH_LENGTH) throw invalidRequest();
  return { query: trimmed };
}

export function parseAnswerConversationPromptRequest(value: unknown): AnswerConversationPromptRequest {
  const request = asRecord(value);
  return {
    conversationId: parseId(request.conversationId),
    messageId: parseId(request.messageId),
    answer: stringValue(request.answer, 128),
  };
}

export function parseMarkConversationReadRequest(value: unknown): MarkConversationReadRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId) };
}

export function parseResolveToolApprovalRequest(value: unknown): ResolveToolApprovalRequest {
  const request = asRecord(value);
  const decision = request.decision;
  if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny" && decision !== "block") {
    throw invalidRequest();
  }
  return {
    approvalId: parseId(request.approvalId),
    conversationId: parseId(request.conversationId),
    toolCallId: parseId(request.toolCallId),
    decision,
  };
}

function stringValue(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw invalidRequest();
  return value;
}

export function parseUsageReportRequest(value: unknown): UsageReportRequest {
  const { period } = asRecord(value);
  if (period !== "7d" && period !== "30d" && period !== "all") throw invalidRequest();
  return { period };
}

export function parseContextRequest(value: unknown): ContextRequest {
  const request = asRecord(value);
  const conversationId = parseId(request.conversationId);
  const command = asRecord(request.command);
  if (Object.keys(request).some((key) => !["conversationId", "command"].includes(key))) throw invalidRequest();
  if (command.action === "save") {
    if (
      Object.keys(command).some((key) => !["action", "policy", "memory"].includes(key)) ||
      !isContextPolicy(command.policy) ||
      typeof command.memory !== "string" ||
      command.memory.length > 8000
    )
      throw invalidRequest();
    return { conversationId, command: { action: "save", policy: command.policy, memory: command.memory } };
  }
  if (Object.keys(command).length !== 1 || !["get", "compact", "new_topic"].includes(String(command.action)))
    throw invalidRequest();
  return { conversationId, command: { action: command.action as "get" | "compact" | "new_topic" } };
}

export function parseSaveVoiceCredentialRequest(value: unknown): SaveVoiceCredentialRequest {
  const request = asRecord(value);
  if (!isVoiceProviderId(request.providerId)) throw invalidRequest();
  if (typeof request.apiKey !== "string" || request.apiKey.length > 20_000) throw invalidRequest();
  return { providerId: request.providerId, apiKey: request.apiKey };
}

export function parseTranscribeAudioRequest(value: unknown): TranscribeAudioRequest {
  const request = asRecord(value);
  const { providerId, modelId, language, mimeType, audio } = request;
  if (
    !isVoiceProviderId(providerId) ||
    !isVoiceModel(providerId, modelId) ||
    !isVoiceLanguage(language) ||
    !VOICE_AUDIO_MIME_TYPES.some((type) => type === mimeType) ||
    !(audio instanceof Uint8Array)
  ) {
    throw invalidRequest();
  }
  if (audio.byteLength === 0) {
    throw new WispBackendError("invalid_request", "The recording is empty.");
  }
  if (audio.byteLength > MAX_VOICE_AUDIO_BYTES) {
    throw new WispBackendError("invalid_request", "The recording is too long to transcribe. Try a shorter one.");
  }
  return { providerId, modelId, language, mimeType: mimeType as VoiceAudioMimeType, audio };
}

function parseMessageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_MESSAGE_LENGTH) throw invalidRequest();
  return value;
}

function parseTimeZone(value: unknown): string {
  if (!isTimeZone(value)) throw invalidRequest();
  return value;
}

function parseMessageSchedule(value: unknown) {
  const schedule = normalizeMessageSchedule(value);
  if (!schedule) throw invalidRequest();
  return schedule;
}

export function parseScheduleMessageRequest(value: unknown): ScheduleMessageRequest {
  const request = asRecord(value);
  return {
    conversationId: parseId(request.conversationId),
    text: parseMessageText(request.text),
    schedule: parseMessageSchedule(request.schedule),
    timeZone: parseTimeZone(request.timeZone),
  };
}

export function parseUpdateScheduledMessageRequest(value: unknown): UpdateScheduledMessageRequest {
  const request = asRecord(value);
  return {
    scheduledMessageId: parseId(request.scheduledMessageId),
    ...(request.text === undefined ? {} : { text: parseMessageText(request.text) }),
    ...(request.schedule === undefined ? {} : { schedule: parseMessageSchedule(request.schedule) }),
    ...(request.timeZone === undefined ? {} : { timeZone: parseTimeZone(request.timeZone) }),
  };
}

export function parseScheduledMessageRequest(value: unknown): ScheduledMessageRequest {
  return { scheduledMessageId: parseId(asRecord(value).scheduledMessageId) };
}

export function parseQueueMessageRequest(value: unknown): QueueMessageRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId), text: parseMessageText(request.text) };
}

export function parseUpdateQueuedMessageRequest(value: unknown): UpdateQueuedMessageRequest {
  const request = asRecord(value);
  return { queuedMessageId: parseId(request.queuedMessageId), text: parseMessageText(request.text) };
}

export function parseQueuedMessageRequest(value: unknown): QueuedMessageRequest {
  return { queuedMessageId: parseId(asRecord(value).queuedMessageId) };
}
