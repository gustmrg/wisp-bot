import { isContextPolicy, type ContextRequest } from "../../shared/context-policy.js";
import type {
  UsageReportRequest,
  ApplyModelRequest,
  ConversationRequest,
  ModelSelection,
  RemoveProviderCredentialRequest,
  SaveAiSettingsRequest,
  SendMessageRequest,
} from "../../shared/contracts.js";
import type {
  AnswerConversationPromptRequest,
  AppendConversationMessageRequest,
  CreateConversationRequest,
  DeleteConversationRequest,
  InitializeConversationsRequest,
  MarkConversationReadRequest,
  MessagePageRequest,
  SearchMessagesRequest,
  UpdateConversationRequest,
} from "../../shared/conversations.js";
import { MAX_MESSAGE_SEARCH_LENGTH, MIN_MESSAGE_SEARCH_LENGTH } from "../../shared/message-search.js";
import { isValidSkillName, type SkillRequest } from "../../shared/skills.js";
import type { ResolveToolApprovalRequest } from "../../shared/tool-policy.js";
import { WispBackendError } from "../backend/backend-error.js";
import {
  normalizeChatChanges,
  normalizeChat,
  normalizeChatCollection,
  normalizeMessage,
} from "../backend/conversation-normalizer.js";

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

export function parseInitializeConversationsRequest(value: unknown): InitializeConversationsRequest {
  const request = asRecord(value);
  return { chats: normalizeChatCollection(request.chats) };
}

export function parseCreateConversationRequest(value: unknown): CreateConversationRequest {
  const request = asRecord(value);
  const model = request.model;
  return {
    conversation: normalizeChat(request.conversation),
    ...(model === undefined || model === null ? { model: null } : { model: parseModelSelection(model) }),
  };
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
