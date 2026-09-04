import type {
  AnswerConversationPromptRequest,
  AppendConversationMessageRequest,
  ConversationStateView,
  CreateConversationRequest,
  DeleteConversationRequest,
  InitializeConversationsRequest,
  MarkConversationReadRequest,
  UpdateConversationRequest,
} from "./conversations.js";
import type { ResolveToolApprovalRequest, ToolApprovalRequest, ToolPolicySettings } from "./tool-policy.js";

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
  getConversationState: "wisp:conversations:get",
  initializeConversations: "wisp:conversations:initialize",
  createConversation: "wisp:conversations:create",
  updateConversation: "wisp:conversations:update",
  deleteConversation: "wisp:conversations:delete",
  appendConversationMessage: "wisp:conversations:append-message",
  answerConversationPrompt: "wisp:conversations:answer-prompt",
  markConversationRead: "wisp:conversations:mark-read",
  getSessionReport: "wisp:conversations:get-session-report",
  getToolPolicy: "wisp:tool-policy:get",
  saveToolPolicy: "wisp:tool-policy:save",
  resolveToolApproval: "wisp:tool-policy:resolve-approval",
  getUpdateState: "wisp:update:get-state",
  checkForUpdates: "wisp:update:check",
  downloadUpdate: "wisp:update:download",
  installUpdate: "wisp:update:install",
  updateState: "wisp:update:state",
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
  maxOutputTokens?: number;
}

export interface ModelSummary {
  id: string;
  name: string;
  reasoning: boolean;
  input: ReadonlyArray<"text" | "image">;
  contextWindow: number;
  maxOutputTokens: number;
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
  | "configuration_required"
  | "disposed"
  | "internal_error"
  | "invalid_configuration"
  | "invalid_request"
  | "not_found"
  | "model_unavailable"
  | "approval_expired"
  | "tool_blocked"
  | "secure_storage_unavailable";

export interface BackendError {
  code: BackendErrorCode;
  message: string;
  retryable: boolean;
}

export type BackendResult<T> = { ok: true; value: T } | { ok: false; error: BackendError };

export type EmptyResult = BackendResult<Record<string, never>>;

export type ConversationStatus = "configuration_required" | "idle" | "working" | "disposed";

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
      createdAt: string;
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
      createdAt: string;
      error: BackendError;
    }
  | {
      type: "tool_activity";
      conversationId: string;
      requestId: string;
      toolCallId: string;
      toolName: string;
      phase: "started" | "updated" | "completed";
      isError?: boolean;
    }
  | {
      type: "conversation_notice";
      conversationId: string;
      requestId?: string;
      kind: "retry_started" | "retry_finished" | "compaction_started" | "compaction_finished";
    }
  | {
      type: "tool_approval_requested";
      conversationId: string;
      request: ToolApprovalRequest;
    }
  | {
      type: "tool_approval_resolved";
      conversationId: string;
      approvalId: string;
      toolCallId: string;
      decision: "allow_once" | "deny" | "block" | "expired";
    };

export type SequencedConversationAgentEvent = ConversationAgentEvent & { sequence: number };

export interface SessionReportUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface SessionReportModelUsage {
  providerId: string;
  modelId: string;
  turns: number;
  usage: SessionReportUsage;
  costUsd: number | null;
}

export interface SessionReportToolCall {
  toolCallId: string;
  toolName: string;
  argumentSummary: string;
  status: "completed" | "error" | "pending";
  timestamp: string;
}

export interface SessionReportEvent {
  kind: "compaction" | "error";
  timestamp: string;
  detail: string;
}

export interface WispSessionReport {
  sessionId: string;
  generatedAt: string;
  turns: number;
  totals: SessionReportUsage & { costUsd: number | null };
  models: ReadonlyArray<SessionReportModelUsage>;
  toolCalls: ReadonlyArray<SessionReportToolCall>;
  events: ReadonlyArray<SessionReportEvent>;
}

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

export interface WispApi {
  startConversation(request: ConversationRequest): Promise<EmptyResult>;
  sendMessage(request: SendMessageRequest): Promise<EmptyResult>;
  abortConversation(request: ConversationRequest): Promise<EmptyResult>;
  applyModel(request: ApplyModelRequest): Promise<EmptyResult>;
  disposeConversation(request: ConversationRequest): Promise<EmptyResult>;
  subscribeToAgentEvents(listener: (event: SequencedConversationAgentEvent) => void): () => void;
  getAiSettings(): Promise<BackendResult<AiSettingsView>>;
  saveAiSettings(request: SaveAiSettingsRequest): Promise<BackendResult<AiSettingsView>>;
  removeProviderCredential(request: RemoveProviderCredentialRequest): Promise<BackendResult<AiSettingsView>>;
  getConversationState(): Promise<BackendResult<ConversationStateView>>;
  initializeConversations(request: InitializeConversationsRequest): Promise<BackendResult<ConversationStateView>>;
  createConversation(request: CreateConversationRequest): Promise<BackendResult<ConversationStateView>>;
  updateConversation(request: UpdateConversationRequest): Promise<BackendResult<ConversationStateView>>;
  deleteConversation(request: DeleteConversationRequest): Promise<BackendResult<ConversationStateView>>;
  appendConversationMessage(request: AppendConversationMessageRequest): Promise<BackendResult<ConversationStateView>>;
  answerConversationPrompt(request: AnswerConversationPromptRequest): Promise<BackendResult<ConversationStateView>>;
  markConversationRead(request: MarkConversationReadRequest): Promise<BackendResult<ConversationStateView>>;
  getSessionReport(request: ConversationRequest): Promise<BackendResult<WispSessionReport | null>>;
  getToolPolicy(): Promise<BackendResult<ToolPolicySettings>>;
  saveToolPolicy(settings: ToolPolicySettings): Promise<BackendResult<ToolPolicySettings>>;
  resolveToolApproval(request: ResolveToolApprovalRequest): Promise<EmptyResult>;
  getUpdateState(): Promise<BackendResult<UpdateState>>;
  checkForUpdates(): Promise<BackendResult<UpdateState>>;
  downloadUpdate(): Promise<BackendResult<UpdateState>>;
  installUpdate(): Promise<EmptyResult>;
  subscribeToUpdateState(listener: (state: UpdateState) => void): () => void;
}
