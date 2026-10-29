import type { JobRequest, SetJobMemoryRequest } from "../shared/jobs.js";
import { isContextPolicy, withPolicyDefaults, type ContextRequest } from "../shared/context-policy.js";
import {
  isThinkingLevel,
  type UsageReportRequest,
  type ApplyFallbackModelRequest,
  type ApplyModelRequest,
  type ConversationRequest,
  type FinishProviderSignInRequest,
  type ModelSelection,
  type ProviderSignInRequest,
  type RemoveProviderCredentialRequest,
  type SaveAiSettingsRequest,
  type SaveAuxiliaryModelRequest,
  type SaveFallbackModelRequest,
  type SendMessageRequest,
  type SetUserTimeZoneRequest,
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
import {
  MAX_MEMORY_OPERATIONS,
  MAX_MEMORY_TEXT_LENGTH,
  MEMORY_SCOPES,
  type ApplyMemoryRequest,
  type ExportMemoryRequest,
  type MemoryOperationRequest,
  type MemoryScope,
} from "../shared/memory.js";
import { MAX_MESSAGE_SEARCH_LENGTH, MIN_MESSAGE_SEARCH_LENGTH } from "../shared/message-search.js";
import {
  MAX_ARCHIVE_DELETIONS,
  MAX_CLEANUP_PATHS,
  type StorageArchiveDeletionRequest,
  type StorageCleanupConfirmation,
  type StorageCleanupRequest,
  type StorageDirectoryRequest,
  type StorageSummaryRequest,
} from "../shared/storage.js";
import { isValidSkillName, type ImportSkillRequest, type SkillRequest } from "../shared/skills.js";
import {
  isWorkspaceFileCategory,
  type ResolveToolApprovalRequest,
  type SaveWispToolPolicyRequest,
} from "../shared/tool-policy.js";
import {
  isVoiceLanguage,
  isVoiceModel,
  isVoiceProviderId,
  MAX_VOICE_AUDIO_BYTES,
  MAX_VOICE_FALLBACKS,
  VOICE_AUDIO_MIME_TYPES,
  type RemoveVoiceCredentialRequest,
  type SaveVoiceCredentialRequest,
  type TranscribeAudioRequest,
  type VoiceAudioMimeType,
  type VoiceModelChoice,
} from "../shared/voice.js";
import type { QueuedMessageRequest, QueueMessageRequest, UpdateQueuedMessageRequest } from "../shared/message-queue.js";
import type {
  ScheduledMessageRequest,
  ScheduleMessageRequest,
  UpdateScheduledMessageRequest,
} from "../shared/scheduled-messages.js";
import { MAX_FILE_MENTION_QUERY_LENGTH } from "../shared/file-mentions.js";
import {
  WORKSPACE_QUOTA_PRESETS,
  type SearchWorkspaceFilesRequest,
  type SetWorkspaceQuotaRequest,
} from "../shared/workspace.js";
import {
  EXECUTION_MODES,
  isContainerImage,
  type ExecutionMode,
  type SaveWispExecutionRequest,
} from "../shared/execution.js";
import { WispBackendError } from "./backend-error.js";
import { MAX_SKILL_FILE_BYTES } from "./skill-store.js";
import {
  normalizeChatChanges,
  normalizeChat,
  normalizeMessage,
  normalizeWisp,
  normalizeWispChanges,
} from "./conversation-normalizer.js";
import { normalizeMessageSchedule } from "./message-schedule.js";
import { isTimeZone } from "../shared/time-zone.js";

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

export function parseSearchWorkspaceFilesRequest(value: unknown): SearchWorkspaceFilesRequest {
  const request = asRecord(value);
  const query = request.query;
  if (typeof query !== "string" || query.length > MAX_FILE_MENTION_QUERY_LENGTH) throw invalidRequest();
  return { conversationId: parseId(request.conversationId), query };
}

export function parseSetWorkspaceQuotaRequest(value: unknown): SetWorkspaceQuotaRequest {
  const request = asRecord(value);
  const quotaBytes = request.quotaBytes;
  if (quotaBytes !== null && (typeof quotaBytes !== "number" || !WORKSPACE_QUOTA_PRESETS.includes(quotaBytes))) {
    throw invalidRequest();
  }
  return { conversationId: parseId(request.conversationId), quotaBytes };
}

export function parseSaveWispExecutionRequest(value: unknown): SaveWispExecutionRequest {
  const request = asRecord(value);
  const { mode, image, localNetwork, browser } = request;
  if (typeof localNetwork !== "boolean") throw invalidRequest();
  if (browser !== undefined && typeof browser !== "boolean") throw invalidRequest();
  if (typeof mode !== "string" || !EXECUTION_MODES.includes(mode as ExecutionMode)) throw invalidRequest();
  if (image !== null && (typeof image !== "string" || !isContainerImage(image))) throw invalidRequest();
  return {
    conversationId: parseId(request.conversationId),
    mode: mode as ExecutionMode,
    image,
    localNetwork,
    ...(browser === undefined ? {} : { browser }),
  };
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
  const thinkingLevel = model.thinkingLevel;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw invalidRequest();
  return {
    providerId: parseId(model.providerId),
    modelId: parseCatalogId(model.modelId),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: maxOutputTokens as number }),
    ...(thinkingLevel === undefined || thinkingLevel === "off" ? {} : { thinkingLevel }),
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

export function parseSaveAuxiliaryModelRequest(value: unknown): SaveAuxiliaryModelRequest {
  const request = asRecord(value);
  if (request.task !== "imageUnderstanding") throw invalidRequest();
  if (request.selection === null) return { task: request.task, selection: null };
  const { providerId, modelId } = parseModelSelection(request.selection);
  return { task: request.task, selection: { providerId, modelId } };
}

/** A fallback names a provider and model only; it takes the output limit and reasoning of the model it stands in for. */
function parseModelChoice(value: unknown): ModelSelection {
  const { providerId, modelId } = parseModelSelection(value);
  return { providerId, modelId };
}

export function parseSaveFallbackModelRequest(value: unknown): SaveFallbackModelRequest {
  const request = asRecord(value);
  return { selection: request.selection === null ? null : parseModelChoice(request.selection) };
}

export function parseApplyFallbackModelRequest(value: unknown): ApplyFallbackModelRequest {
  const request = asRecord(value);
  const { fallback } = request;
  return {
    conversationId: parseId(request.conversationId),
    fallback: fallback === "off" || fallback === "global" ? fallback : parseModelChoice(fallback),
  };
}

export function parseRemoveProviderCredentialRequest(value: unknown): RemoveProviderCredentialRequest {
  const request = asRecord(value);
  return { providerId: parseId(request.providerId) };
}

export function parseProviderSignInRequest(value: unknown): ProviderSignInRequest {
  const request = asRecord(value);
  return { providerId: parseId(request.providerId) };
}

const MAX_REDIRECT_URL_LENGTH = 8192;

export function parseFinishProviderSignInRequest(value: unknown): FinishProviderSignInRequest {
  const request = asRecord(value);
  const redirectUrl = typeof request.redirectUrl === "string" ? request.redirectUrl.trim() : "";
  if (!redirectUrl || redirectUrl.length > MAX_REDIRECT_URL_LENGTH) {
    throw new WispBackendError("invalid_request", "Paste the address of the page the sign-in sent you to.");
  }
  return { providerId: parseId(request.providerId), redirectUrl };
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
  if (
    decision !== "allow_once" &&
    decision !== "allow_always" &&
    decision !== "allow_integration" &&
    decision !== "deny" &&
    decision !== "block"
  ) {
    throw invalidRequest();
  }
  return {
    approvalId: parseId(request.approvalId),
    conversationId: parseId(request.conversationId),
    toolCallId: parseId(request.toolCallId),
    decision,
  };
}

export function parseSaveWispToolPolicyRequest(value: unknown): SaveWispToolPolicyRequest {
  const request = asRecord(value);
  const files = asRecord(request.files);
  if (typeof request.allowEverything !== "boolean") throw invalidRequest();
  const parsed: SaveWispToolPolicyRequest = {
    conversationId: parseId(request.conversationId),
    files: {},
    allowEverything: request.allowEverything,
  };
  for (const [category, behavior] of Object.entries(files)) {
    if (!isWorkspaceFileCategory(category) || (behavior !== "allow" && behavior !== "ask" && behavior !== "block"))
      throw invalidRequest();
    parsed.files[category] = behavior;
  }
  return parsed;
}

function stringValue(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw invalidRequest();
  return value;
}

export function parseUsageReportRequest(value: unknown): UsageReportRequest {
  const { period, conversationId } = asRecord(value);
  if (period !== "7d" && period !== "30d" && period !== "all") throw invalidRequest();
  return conversationId === undefined ? { period } : { period, conversationId: parseId(conversationId) };
}

function parseMemoryScope(value: unknown): MemoryScope {
  if (!MEMORY_SCOPES.includes(value as MemoryScope)) throw invalidRequest();
  return value as MemoryScope;
}

function parseMemoryText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_MEMORY_TEXT_LENGTH) throw invalidRequest();
  return value;
}

/** The shape of each operation; whether it can apply is the memory store's to say. */
function parseMemoryOperation(value: unknown): MemoryOperationRequest {
  const operation = asRecord(value);
  const keys = (allowed: string[]) => {
    if (Object.keys(operation).some((key) => !allowed.includes(key))) throw invalidRequest();
  };
  switch (operation.op) {
    case "add": {
      keys(["op", "scope", "text", "expiresAt"]);
      const { expiresAt } = operation;
      if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== "string" || expiresAt.length > 64))
        throw invalidRequest();
      return {
        op: "add",
        scope: parseMemoryScope(operation.scope),
        text: parseMemoryText(operation.text),
        ...(typeof expiresAt === "string" ? { expiresAt } : {}),
      };
    }
    case "patch":
      keys(["op", "id", "text"]);
      return { op: "patch", id: parseId(operation.id), text: parseMemoryText(operation.text) };
    case "remove":
    case "restore":
      keys(["op", "id"]);
      return { op: operation.op, id: parseId(operation.id) };
    default:
      throw invalidRequest();
  }
}

export function parseApplyMemoryRequest(value: unknown): ApplyMemoryRequest {
  const request = asRecord(value);
  const { operations } = request;
  if (!Array.isArray(operations) || operations.length > MAX_MEMORY_OPERATIONS) throw invalidRequest();
  return { conversationId: parseId(request.conversationId), operations: operations.map(parseMemoryOperation) };
}

export function parseExportMemoryRequest(value: unknown): ExportMemoryRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId), scope: parseMemoryScope(request.scope) };
}

export function parseContextRequest(value: unknown): ContextRequest {
  const request = asRecord(value);
  const conversationId = parseId(request.conversationId);
  const command = asRecord(request.command);
  if (Object.keys(request).some((key) => !["conversationId", "command"].includes(key))) throw invalidRequest();
  if (command.action === "save") {
    // Clients older than a policy field send the policy without it.
    const policy = withPolicyDefaults(command.policy);
    if (
      Object.keys(command).some((key) => !["action", "policy", "memory"].includes(key)) ||
      !isContextPolicy(policy) ||
      typeof command.memory !== "string" ||
      command.memory.length > 8000
    )
      throw invalidRequest();
    return { conversationId, command: { action: "save", policy, memory: command.memory } };
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

export function parseRemoveVoiceCredentialRequest(value: unknown): RemoveVoiceCredentialRequest {
  const request = asRecord(value);
  if (Object.keys(request).length !== 1 || !isVoiceProviderId(request.providerId)) throw invalidRequest();
  return { providerId: request.providerId };
}

export function parseTranscribeAudioRequest(value: unknown): TranscribeAudioRequest {
  const request = asRecord(value);
  const { providerId, modelId, language, mimeType, audio } = request;
  const fallbacks = request.fallbacks === undefined ? [] : parseVoiceFallbacks(request.fallbacks);
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
  return {
    providerId,
    modelId,
    ...(fallbacks.length ? { fallbacks } : {}),
    language,
    mimeType: mimeType as VoiceAudioMimeType,
    audio,
  };
}

function parseVoiceFallbacks(value: unknown): VoiceModelChoice[] {
  if (!Array.isArray(value) || value.length > MAX_VOICE_FALLBACKS) throw invalidRequest();
  return value.map((item) => {
    const choice = asRecord(item);
    if (Object.keys(choice).length !== 2 || !isVoiceProviderId(choice.providerId)) throw invalidRequest();
    if (!isVoiceModel(choice.providerId, choice.modelId)) throw invalidRequest();
    return { providerId: choice.providerId, modelId: choice.modelId };
  });
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

export function parseSetUserTimeZoneRequest(value: unknown): SetUserTimeZoneRequest {
  return { timeZone: parseTimeZone(asRecord(value).timeZone) };
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

export function parseJobRequest(value: unknown): JobRequest {
  return { jobId: parseId(asRecord(value).jobId) };
}

export function parseSetJobMemoryRequest(value: unknown): SetJobMemoryRequest {
  const request = asRecord(value);
  if (typeof request.useMemory !== "boolean") throw invalidRequest();
  return { jobId: parseId(request.jobId), useMemory: request.useMemory };
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

export function parseStorageSummaryRequest(value: unknown): StorageSummaryRequest {
  if (value === undefined || value === null) return {};
  const request = asRecord(value);
  if (request.refresh !== undefined && typeof request.refresh !== "boolean") throw invalidRequest();
  return request.refresh ? { refresh: true } : {};
}

export function parseStorageDirectoryRequest(value: unknown): StorageDirectoryRequest {
  const request = asRecord(value);
  if (typeof request.path !== "string") throw invalidRequest();
  if (request.cursor !== undefined && typeof request.cursor !== "string") throw invalidRequest();
  return {
    conversationId: parseId(request.conversationId),
    path: request.path,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

function parseStringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) {
    throw invalidRequest();
  }
  return value as string[];
}

export function parseStorageCleanupRequest(value: unknown): StorageCleanupRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId), paths: parseStringList(request.paths, MAX_CLEANUP_PATHS) };
}

export function parseStorageCleanupConfirmation(value: unknown): StorageCleanupConfirmation {
  const request = asRecord(value);
  if (typeof request.fingerprint !== "string" || request.fingerprint.length > 128) throw invalidRequest();
  return { ...parseStorageCleanupRequest(value), fingerprint: request.fingerprint };
}

export function parseStorageArchiveDeletionRequest(value: unknown): StorageArchiveDeletionRequest {
  return { ids: parseStringList(asRecord(value).ids, MAX_ARCHIVE_DELETIONS) };
}
