import type { ContextRequest, ContextView } from "./context-policy.js";
import type {
  PluginSettingsView,
  PluginRequest,
  SavePluginSettingsRequest,
  TestPluginConnectionRequest,
  PluginConnectionResult,
  WispPluginAccessView,
  SaveWispPluginAccessRequest,
} from "./plugins.js";
import type {
  McpSettingsView,
  McpConnectionResult,
  SaveMcpServerRequest,
  McpServerRequest,
  TestMcpConnectionRequest,
  WispMcpAccessView,
  SaveWispMcpAccessRequest,
} from "./mcp.js";
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
  getConversationModel: "wisp:agent:get-model",
  manageContext: "wisp:agent:context",
  disposeConversation: "wisp:agent:dispose",
  agentEvent: "wisp:agent:event",
  getAiSettings: "wisp:settings:ai:get",
  getPluginSettings: "wisp:plugins:get",
  savePluginSettings: "wisp:plugins:save",
  removePlugin: "wisp:plugins:remove",
  testPluginConnection: "wisp:plugins:test",
  getWispPluginAccess: "wisp:plugins:access:get",
  saveWispPluginAccess: "wisp:plugins:access:save",
  getMcpSettings: "wisp:mcp:get",
  saveMcpServer: "wisp:mcp:save",
  removeMcpServer: "wisp:mcp:remove",
  testMcpConnection: "wisp:mcp:test",
  refreshMcpTools: "wisp:mcp:refresh",
  startMcpSignIn: "wisp:mcp:sign-in",
  cancelMcpSignIn: "wisp:mcp:sign-in:cancel",
  mcpSettingsChanged: "wisp:mcp:changed",
  getWispMcpAccess: "wisp:mcp:access:get",
  saveWispMcpAccess: "wisp:mcp:access:save",
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
  getUsageReport: "wisp:usage:get",
  getToolPolicy: "wisp:tool-policy:get",
  saveToolPolicy: "wisp:tool-policy:save",
  resolveToolApproval: "wisp:tool-policy:resolve-approval",
  getUpdateState: "wisp:update:get-state",
  checkForUpdates: "wisp:update:check",
  downloadUpdate: "wisp:update:download",
  installUpdate: "wisp:update:install",
  openReleasesPage: "wisp:update:open-releases",
  updateState: "wisp:update:state",
} as const;

export const WISP_RELEASES_URL = "https://github.com/gustmrg/wisp-bot/releases/latest";

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
  /** Set when the model catalog could not be fully loaded or refreshed and the built-in list is shown. */
  catalogError: string | null;
}

export interface SaveAiSettingsRequest {
  selection: ModelSelection;
  apiKey?: string;
}

export interface RemoveProviderCredentialRequest {
  providerId: string;
}

export interface ApplyModelRequest extends ConversationRequest {
  model: ModelSelection | null;
}

export interface ConversationModelView {
  override: ModelSelection | null;
  effective: ModelSelection | null;
  applied: ModelSelection | null;
  pending: ModelSelection | null;
  status: ConversationStatus;
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
  | { type: "conversation_context_renewed"; conversationId: string; kind: "compacted" | "new_topic"; createdAt: string }
  | {
      type: "conversation_model_changed";
      conversationId: string;
      applied: ModelSelection | null;
      pending: ModelSelection | null;
    }
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
  kind: "compaction" | "error" | "retry_started" | "retry_finished";
  timestamp: string;
  detail: string;
}

export interface WispSessionReport {
  compactionUsage?: SessionReportUsage;
  sessionId: string;
  generatedAt: string;
  piVersion?: string;
  turns: number;
  totals: SessionReportUsage & { costUsd: number | null };
  models: ReadonlyArray<SessionReportModelUsage>;
  toolCalls: ReadonlyArray<SessionReportToolCall>;
  events: ReadonlyArray<SessionReportEvent>;
}

export type UsagePeriod = "7d" | "30d" | "all";

export interface UsageReportRequest {
  period: UsagePeriod;
}

export interface WispUsageRow {
  conversationId: string;
  name: string;
  sessions: number;
  totals: SessionReportUsage & { costUsd: number | null };
}

export interface UsageReport {
  generatedAt: string;
  from: string | null;
  period: UsagePeriod;
  pricingUpdatedAt: string | null;
  incomplete: boolean;
  wisps: ReadonlyArray<WispUsageRow>;
  totals: SessionReportUsage & { costUsd: number | null };
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "manual-download"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

export interface WispApi {
  getPluginSettings(): Promise<BackendResult<PluginSettingsView>>;
  savePluginSettings(request: SavePluginSettingsRequest): Promise<BackendResult<PluginSettingsView>>;
  removePlugin(request: PluginRequest): Promise<BackendResult<PluginSettingsView>>;
  testPluginConnection(request: TestPluginConnectionRequest): Promise<BackendResult<PluginConnectionResult>>;
  getWispPluginAccess(request: ConversationRequest): Promise<BackendResult<WispPluginAccessView>>;
  saveWispPluginAccess(request: SaveWispPluginAccessRequest): Promise<BackendResult<WispPluginAccessView>>;
  getMcpSettings(): Promise<BackendResult<McpSettingsView>>;
  saveMcpServer(request: SaveMcpServerRequest): Promise<BackendResult<McpSettingsView>>;
  removeMcpServer(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  testMcpConnection(request: TestMcpConnectionRequest): Promise<BackendResult<McpConnectionResult>>;
  refreshMcpTools(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  startMcpSignIn(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  cancelMcpSignIn(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  getWispMcpAccess(request: ConversationRequest): Promise<BackendResult<WispMcpAccessView>>;
  saveWispMcpAccess(request: SaveWispMcpAccessRequest): Promise<BackendResult<WispMcpAccessView>>;
  subscribeToMcpSettings(listener: (view: McpSettingsView) => void): () => void;
  manageContext(request: ContextRequest): Promise<BackendResult<ContextView>>;
  startConversation(request: ConversationRequest): Promise<EmptyResult>;
  sendMessage(request: SendMessageRequest): Promise<EmptyResult>;
  abortConversation(request: ConversationRequest): Promise<EmptyResult>;
  applyModel(request: ApplyModelRequest): Promise<EmptyResult>;
  getConversationModel(request: ConversationRequest): Promise<BackendResult<ConversationModelView>>;
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
  getUsageReport(request: UsageReportRequest): Promise<BackendResult<UsageReport>>;
  getToolPolicy(): Promise<BackendResult<ToolPolicySettings>>;
  saveToolPolicy(settings: ToolPolicySettings): Promise<BackendResult<ToolPolicySettings>>;
  resolveToolApproval(request: ResolveToolApprovalRequest): Promise<EmptyResult>;
  getUpdateState(): Promise<BackendResult<UpdateState>>;
  checkForUpdates(): Promise<BackendResult<UpdateState>>;
  downloadUpdate(): Promise<BackendResult<UpdateState>>;
  installUpdate(): Promise<EmptyResult>;
  openReleasesPage(): Promise<EmptyResult>;
  subscribeToUpdateState(listener: (state: UpdateState) => void): () => void;
}
