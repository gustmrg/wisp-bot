export const WISP_IPC_CHANNELS = {
  startConversation: "wisp:agent:start",
  sendMessage: "wisp:agent:send",
  abortConversation: "wisp:agent:abort",
  applyModel: "wisp:agent:apply-model",
  disposeConversation: "wisp:agent:dispose",
  agentEvent: "wisp:agent:event",
  getAiSettings: "wisp:settings:ai:get",
  saveAiSettings: "wisp:settings:ai:save",
  removeProviderCredential: "wisp:settings:ai:remove-credential",
} as const;

export interface ConversationRequest {
  conversationId: string;
}

export interface SendMessageRequest extends ConversationRequest {
  requestId: string;
  text: string;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  reasoning: boolean;
  input: ReadonlyArray<"text" | "image">;
  contextWindow: number;
}

export interface ProviderSummary {
  id: string;
  name: string;
  credentialConfigured: boolean;
  models: ReadonlyArray<ModelSummary>;
}

export interface AiSettingsView {
  selection: ModelSelection | null;
  secureStorageAvailable: boolean;
  providers: ReadonlyArray<ProviderSummary>;
}

export interface SaveAiSettingsRequest {
  selection: ModelSelection;
  apiKey?: string;
}

export interface RemoveProviderCredentialRequest {
  providerId: string;
}

export interface ApplyModelRequest extends ConversationRequest {
  model: ModelSelection;
}

export type BackendErrorCode =
  | "aborted"
  | "already_exists"
  | "disposed"
  | "internal_error"
  | "invalid_configuration"
  | "invalid_request"
  | "not_found"
  | "secure_storage_unavailable";

export interface BackendError {
  code: BackendErrorCode;
  message: string;
  retryable: boolean;
}

export type BackendResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BackendError };

export type EmptyResult = BackendResult<Record<string, never>>;

export type ConversationStatus = "idle" | "working" | "disposed";

export type ConversationAgentEvent =
  | {
      type: "conversation_status";
      conversationId: string;
      status: ConversationStatus;
    }
  | {
      type: "assistant_message_started";
      conversationId: string;
      requestId: string;
      messageId: string;
    }
  | {
      type: "assistant_text_delta";
      conversationId: string;
      requestId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "assistant_message_completed";
      conversationId: string;
      requestId: string;
      messageId: string;
    }
  | {
      type: "assistant_message_cancelled";
      conversationId: string;
      requestId: string;
      messageId: string;
    }
  | {
      type: "conversation_error";
      conversationId: string;
      requestId?: string;
      error: BackendError;
    };

export interface WispApi {
  startConversation(request: ConversationRequest): Promise<EmptyResult>;
  sendMessage(request: SendMessageRequest): Promise<EmptyResult>;
  abortConversation(request: ConversationRequest): Promise<EmptyResult>;
  applyModel(request: ApplyModelRequest): Promise<EmptyResult>;
  disposeConversation(request: ConversationRequest): Promise<EmptyResult>;
  subscribeToAgentEvents(listener: (event: ConversationAgentEvent) => void): () => void;
  getAiSettings(): Promise<BackendResult<AiSettingsView>>;
  saveAiSettings(request: SaveAiSettingsRequest): Promise<BackendResult<AiSettingsView>>;
  removeProviderCredential(
    request: RemoveProviderCredentialRequest,
  ): Promise<BackendResult<AiSettingsView>>;
}
