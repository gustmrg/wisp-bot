import type {
  ApplyModelRequest,
  ConversationRequest,
  ModelSelection,
  RemoveProviderCredentialRequest,
  SaveAiSettingsRequest,
  SendMessageRequest,
} from "../../shared/contracts.js";
import { WispBackendError } from "../backend/backend-error.js";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const MAX_ID_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 100_000;

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
  if (
    typeof value !== "string"
    || value.length > 256
    || !/^[a-zA-Z0-9~][a-zA-Z0-9._:/@~-]*$/.test(value)
  ) {
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
