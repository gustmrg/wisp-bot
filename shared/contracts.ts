import type { ContextRequest, ContextView } from "./context-policy.js";
import type {
  PluginSettingsView,
  PluginRequest,
  SavePluginDefaultsRequest,
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
  ConversationDelta,
  ConversationStateView,
  MessagePage,
  MessagePageRequest,
  MessageSearchHit,
  SearchMessagesRequest,
  CreateConversationRequest,
  DeleteConversationRequest,
  InitializeConversationsRequest,
  MarkConversationReadRequest,
  UpdateConversationRequest,
} from "./conversations.js";
import type { AttachWorkspaceFilesResult, WorkspaceView } from "./workspace.js";
import type { SkillRequest, SkillView } from "./skills.js";
import type { ResolveToolApprovalRequest, ToolApprovalRequest, ToolPolicySettings } from "./tool-policy.js";
import type {
  SaveVoiceCredentialRequest,
  TranscribeAudioRequest,
  TranscriptionResult,
  VoiceSettingsView,
} from "./voice.js";

import type {
  ActivateConnectionRequest,
  ConnectionRequest,
  ConnectionsView,
  SaveConnectionRequest,
  AnswerSshPromptRequest,
  SshConfigHost,
  SshServerCheck,
} from "./connections.js";

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
  savePluginDefaults: "wisp:plugins:defaults:save",
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
  conversationChanged: "wisp:conversations:changed",
  getConversationMessages: "wisp:conversations:get-messages",
  searchMessages: "wisp:conversations:search",
  getSessionReport: "wisp:conversations:get-session-report",
  getUsageReport: "wisp:usage:get",
  getToolPolicy: "wisp:tool-policy:get",
  getUserProfile: "wisp:profile:get",
  saveUserProfile: "wisp:profile:save",
  saveToolPolicy: "wisp:tool-policy:save",
  resolveToolApproval: "wisp:tool-policy:resolve-approval",
  getLaunchAtLoginState: "wisp:login:get",
  setLaunchAtLogin: "wisp:login:set",
  getUpdateState: "wisp:update:get-state",
  checkForUpdates: "wisp:update:check",
  downloadUpdate: "wisp:update:download",
  installUpdate: "wisp:update:install",
  openReleasesPage: "wisp:update:open-releases",
  updateState: "wisp:update:state",
  getWorkspace: "wisp:workspace:get",
  openWorkspaceFolder: "wisp:workspace:open",
  openSkillsFolder: "wisp:workspace:open-skills",
  attachWorkspaceFiles: "wisp:workspace:attach",
  listSkills: "wisp:skills:list",
  deleteSkill: "wisp:skills:delete",
  getVoiceSettings: "wisp:voice:get",
  saveVoiceCredential: "wisp:voice:save-credential",
  transcribeAudio: "wisp:voice:transcribe",
  getConnections: "wisp:connections:get",
  saveConnection: "wisp:connections:save",
  removeConnection: "wisp:connections:remove",
  activateConnection: "wisp:connections:activate",
  retryConnection: "wisp:connections:retry",
  installServer: "wisp:connections:install-server",
  cancelServerInstall: "wisp:connections:cancel-server-install",
  listSshHosts: "wisp:connections:ssh-hosts",
  checkSshServer: "wisp:connections:check-ssh",
  cancelSshCheck: "wisp:connections:cancel-ssh-check",
  answerSshPrompt: "wisp:connections:answer-ssh-prompt",
  connectionsChanged: "wisp:connections:changed",
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
  | "secure_storage_unavailable"
  | "unsupported"
  | "unavailable";

export interface BackendError {
  code: BackendErrorCode;
  message: string;
  retryable: boolean;
  /** Raw provider error text for logs only; never rendered or persisted. */
  detail?: string;
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
      /** The reply message the error belongs to; the request's first reply message when absent. */
      messageId?: string;
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
      decision: "allow_once" | "allow_always" | "deny" | "block" | "expired";
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
  | "installing"
  | "up-to-date"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
  /** The version that ran before this launch, set only on the first launch after an update. */
  updatedFrom?: string;
}

export interface LaunchAtLoginState {
  supported: boolean;
  enabled: boolean;
  reason?: string;
}

export interface WispApi {
  getLaunchAtLoginState(): Promise<BackendResult<LaunchAtLoginState>>;
  setLaunchAtLogin(enabled: boolean): Promise<BackendResult<LaunchAtLoginState>>;
  getPluginSettings(): Promise<BackendResult<PluginSettingsView>>;
  savePluginSettings(request: SavePluginSettingsRequest): Promise<BackendResult<PluginSettingsView>>;
  savePluginDefaults(request: SavePluginDefaultsRequest): Promise<BackendResult<PluginSettingsView>>;
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
  // Single-chat changes return only what changed; structural changes above return the full state.
  appendConversationMessage(request: AppendConversationMessageRequest): Promise<BackendResult<ConversationDelta>>;
  answerConversationPrompt(request: AnswerConversationPromptRequest): Promise<BackendResult<ConversationDelta>>;
  markConversationRead(request: MarkConversationReadRequest): Promise<BackendResult<ConversationDelta>>;
  /** One page of a transcript, read from the backend store. */
  getConversationMessages(request: MessagePageRequest): Promise<BackendResult<MessagePage>>;
  /** Newest matching messages first. The query must have at least 3 characters. */
  searchMessages(request: SearchMessagesRequest): Promise<BackendResult<ReadonlyArray<MessageSearchHit>>>;
  /** Pushes what changed after the backend persists agent-driven changes (replies, statuses, context notices). */
  subscribeToConversationChanges(listener: (delta: ConversationDelta) => void): () => void;
  getSessionReport(request: ConversationRequest): Promise<BackendResult<WispSessionReport | null>>;
  getUsageReport(request: UsageReportRequest): Promise<BackendResult<UsageReport>>;
  getToolPolicy(): Promise<BackendResult<ToolPolicySettings>>;
  getUserProfile(): Promise<BackendResult<import("./user-profile.js").UserProfile>>;
  saveUserProfile(
    profile: import("./user-profile.js").UserProfile,
  ): Promise<BackendResult<import("./user-profile.js").UserProfile>>;
  saveToolPolicy(settings: ToolPolicySettings): Promise<BackendResult<ToolPolicySettings>>;
  resolveToolApproval(request: ResolveToolApprovalRequest): Promise<EmptyResult>;
  getUpdateState(): Promise<BackendResult<UpdateState>>;
  checkForUpdates(): Promise<BackendResult<UpdateState>>;
  downloadUpdate(): Promise<BackendResult<UpdateState>>;
  installUpdate(): Promise<EmptyResult>;
  openReleasesPage(): Promise<EmptyResult>;
  subscribeToUpdateState(listener: (state: UpdateState) => void): () => void;
  getWorkspace(request: ConversationRequest): Promise<BackendResult<WorkspaceView>>;
  openWorkspaceFolder(request: ConversationRequest): Promise<EmptyResult>;
  /** Opens the Wisp's skills folder, creating it on first use. */
  openSkillsFolder(request: ConversationRequest): Promise<EmptyResult>;
  /** Shows a native file picker and copies the chosen files into the Wisp's workspace inbox. */
  attachWorkspaceFiles(request: ConversationRequest): Promise<BackendResult<AttachWorkspaceFilesResult>>;
  /** The Wisp's saved skills, alphabetically; malformed skill files are left out. */
  listSkills(request: ConversationRequest): Promise<BackendResult<ReadonlyArray<SkillView>>>;
  deleteSkill(request: SkillRequest): Promise<BackendResult<ReadonlyArray<SkillView>>>;
  /** Which voice providers have a saved key; keys themselves never leave the backend. */
  getVoiceSettings(): Promise<BackendResult<VoiceSettingsView>>;
  /** Saves a provider key for voice input; chat models of the same provider can use it too. */
  saveVoiceCredential(request: SaveVoiceCredentialRequest): Promise<BackendResult<VoiceSettingsView>>;
  /** Sends a recording to the chosen speech-to-text provider and returns its text. */
  transcribeAudio(request: TranscribeAudioRequest): Promise<BackendResult<TranscriptionResult>>;
  getConnections(): Promise<BackendResult<ConnectionsView>>;
  saveConnection(request: SaveConnectionRequest): Promise<BackendResult<ConnectionsView>>;
  removeConnection(request: ConnectionRequest): Promise<BackendResult<ConnectionsView>>;
  /** Switches the backend; the renderer reloads its state when the status epoch changes. */
  activateConnection(request: ActivateConnectionRequest): Promise<BackendResult<ConnectionsView>>;
  retryConnection(): Promise<BackendResult<ConnectionsView>>;
  /**
   * Installs and starts the Wisp server on a machine reached over SSH, then connects to it.
   * Needs Node.js 22.19 or later there; resolves once the server is running.
   */
  installServer(request: ConnectionRequest): Promise<BackendResult<ConnectionsView>>;
  /** Stops a server setup in progress; `installServer` then fails as cancelled. */
  cancelServerInstall(): Promise<BackendResult<ConnectionsView>>;
  /** The machines in this computer's ~/.ssh/config, to choose from when adding a server. */
  listSshHosts(): Promise<BackendResult<ReadonlyArray<SshConfigHost>>>;
  /**
   * Connects to an SSH server once, asking in the app (`sshPrompt` in the
   * connections view) about an unknown host key or a password, so later
   * connections need none, and reports which Wisp server is installed there.
   */
  checkSshServer(request: ConnectionRequest): Promise<BackendResult<SshServerCheck>>;
  /** Stops a check in progress; `checkSshServer` then fails as cancelled. */
  cancelSshCheck(): Promise<BackendResult<ConnectionsView>>;
  answerSshPrompt(request: AnswerSshPromptRequest): Promise<BackendResult<ConnectionsView>>;
  subscribeToConnections(listener: (view: ConnectionsView) => void): () => void;
}
