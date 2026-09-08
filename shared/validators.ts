import { isContextPolicy, type ContextRequest } from "./context-policy.js";
import type {
  UsageReportRequest,
  ApplyModelRequest,
  ConversationRequest,
  ModelSelection,
  RemoveProviderCredentialRequest,
  SaveAiSettingsRequest,
  SendMessageRequest,
} from "./contracts.js";
import type {
  AnswerConversationPromptRequest,
  AppendConversationMessageRequest,
  CreateConversationRequest,
  DeleteConversationRequest,
  InitializeConversationsRequest,
  MarkConversationReadRequest,
  UpdateConversationRequest,
} from "./conversations.js";
import type { ResolveToolApprovalRequest } from "./tool-policy.js";
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

export function parseExpectedRevision(value: unknown): number | undefined {
  const revision = asRecord(value).expectedRevision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 0)) throw invalidRequest();
  return revision as number | undefined;
}
function expectedRevision(request: Record<string, unknown>): { expectedRevision?: number } {
  const revision = parseExpectedRevision(request);
  return revision === undefined ? {} : { expectedRevision: revision };
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
    ...expectedRevision(request),
    selection: parseModelSelection(request.selection),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

export function parseRemoveProviderCredentialRequest(value: unknown): RemoveProviderCredentialRequest {
  const request = asRecord(value);
  return { ...expectedRevision(request), providerId: parseId(request.providerId) };
}

export function parseApplyModelRequest(value: unknown): ApplyModelRequest {
  const request = asRecord(value);
  return {
    ...expectedRevision(request),
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
  return { conversation: normalizeChat(request.conversation) };
}

export function parseUpdateConversationRequest(value: unknown): UpdateConversationRequest {
  const request = asRecord(value);
  return {
    ...expectedRevision(request),
    conversationId: parseId(request.conversationId),
    changes: normalizeChatChanges(request.changes),
  };
}

export function parseDeleteConversationRequest(value: unknown): DeleteConversationRequest {
  const request = asRecord(value);
  return { ...expectedRevision(request), conversationId: parseId(request.conversationId) };
}

export function parseAppendConversationMessageRequest(value: unknown): AppendConversationMessageRequest {
  const request = asRecord(value);
  return {
    conversationId: parseId(request.conversationId),
    message: normalizeMessage(request.message),
  };
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
  if (decision !== "allow_once" && decision !== "deny" && decision !== "block") throw invalidRequest();
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
  if (Object.keys(request).some((key) => !["conversationId", "command", "expectedRevision"].includes(key)))
    throw invalidRequest();
  if (command.action === "save") {
    if (
      Object.keys(command).some((key) => !["action", "policy", "memory"].includes(key)) ||
      !isContextPolicy(command.policy) ||
      typeof command.memory !== "string" ||
      command.memory.length > 8000
    )
      throw invalidRequest();
    return {
      conversationId,
      ...expectedRevision(request),
      command: { action: "save", policy: command.policy, memory: command.memory },
    };
  }
  if (Object.keys(command).length !== 1 || !["get", "compact", "new_topic"].includes(String(command.action)))
    throw invalidRequest();
  return {
    conversationId,
    ...expectedRevision(request),
    command: { action: command.action as "get" | "compact" | "new_topic" },
  };
}
