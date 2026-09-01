import type {
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
  UpdateConversationRequest,
} from "../../shared/conversations.js";
import type { ResolveToolApprovalRequest } from "../../shared/tool-policy.js";
import { WispBackendError } from "../backend/backend-error.js";
import {
  normalizeAgentSettingsChanges,
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
  return {
    providerId: parseId(model.providerId),
    modelId: parseCatalogId(model.modelId),
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
    model: parseModelSelection(request.model),
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
    conversationId: parseId(request.conversationId),
    changes: normalizeAgentSettingsChanges(request.changes),
  };
}

export function parseDeleteConversationRequest(value: unknown): DeleteConversationRequest {
  const request = asRecord(value);
  return { conversationId: parseId(request.conversationId) };
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
