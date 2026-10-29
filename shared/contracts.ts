import type { ClaudeCodeStatusView } from "./claude-code.js";
import type { ContextRequest, ContextView } from "./context-policy.js";
import type {
  PluginSettingsView,
  PluginRequest,
  SavePluginDefaultsRequest,
  SavePluginSettingsRequest,
  TestPluginConnectionRequest,
  StartPluginSignInRequest,
  FinishPluginSignInRequest,
  PluginConnectionResult,
  WispPluginAccessView,
  SaveWispPluginAccessRequest,
} from "./plugins.js";
import type {
  McpSettingsView,
  McpConnectionResult,
  SaveMcpServerRequest,
  McpServerRequest,
  FinishMcpSignInRequest,
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
  CreateWispRequest,
  DeleteConversationRequest,
  DeleteWispRequest,
  InitializeConversationsRequest,
  MarkConversationReadRequest,
  MarkConversationUnreadRequest,
  UpdateConversationRequest,
  UpdateWispRequest,
  WispsView,
} from "./conversations.js";
import type { JobRequest, JobRunsView, JobsView, SetJobMemoryRequest } from "./jobs.js";
import type {
  RemoteAccessPairing,
  RemoteAccessView,
  RevokeRemoteDeviceRequest,
  SaveRemoteAccessRequest,
} from "./remote-access.js";
import type {
  MessageQueueView,
  QueuedMessage,
  QueuedMessageRequest,
  QueueMessageRequest,
  UpdateQueuedMessageRequest,
} from "./message-queue.js";
import type {
  ScheduledMessageRequest,
  ScheduledMessagesView,
  ScheduleMessageRequest,
  UpdateScheduledMessageRequest,
} from "./scheduled-messages.js";
import type {
  StorageArchiveDeletionRequest,
  StorageArchiveDeletionResult,
  StorageCleanupConfirmation,
  StorageCleanupPreview,
  StorageCleanupRequest,
  StorageCleanupResult,
  StorageDirectoryPage,
  StorageDirectoryRequest,
  StorageSummary,
  StorageSummaryRequest,
} from "./storage.js";
import type {
  AttachWorkspaceFilesOptions,
  AttachWorkspaceFilesResult,
  SearchWorkspaceFilesRequest,
  SetWorkspaceQuotaRequest,
  WorkspaceFileSearch,
  WorkspaceView,
} from "./workspace.js";
import type { SaveWispExecutionRequest, WispExecutionView, WispSetupView } from "./execution.js";
import type { ImportSkillRequest, SkillRequest, SkillView } from "./skills.js";
import type {
  ResolveToolApprovalRequest,
  SaveWispToolPolicyRequest,
  ToolApprovalRequest,
  ToolPolicySettings,
  WispToolPolicyView,
} from "./tool-policy.js";
import type {
  RemoveVoiceCredentialRequest,
  SaveVoiceCredentialRequest,
  TranscribeAudioRequest,
  TranscriptionResult,
  VoiceSettingsView,
} from "./voice.js";

import type {
  ActivateConnectionRequest,
  AnswerSshPromptRequest,
  ConnectionRequest,
  ConnectionsView,
  SaveConnectionRequest,
} from "./connections.js";

export const WISP_IPC_CHANNELS = {
  startConversation: "wisp:agent:start",
  sendMessage: "wisp:agent:send",
  abortConversation: "wisp:agent:abort",
  applyModel: "wisp:agent:apply-model",
  applyFallbackModel: "wisp:agent:apply-fallback",
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
  startPluginSignIn: "wisp:plugins:sign-in",
  cancelPluginSignIn: "wisp:plugins:sign-in:cancel",
  finishPluginSignIn: "wisp:plugins:sign-in:finish",
  pluginSettingsChanged: "wisp:plugins:changed",
  getWispPluginAccess: "wisp:plugins:access:get",
  saveWispPluginAccess: "wisp:plugins:access:save",
  getMcpSettings: "wisp:mcp:get",
  saveMcpServer: "wisp:mcp:save",
  removeMcpServer: "wisp:mcp:remove",
  testMcpConnection: "wisp:mcp:test",
  refreshMcpTools: "wisp:mcp:refresh",
  startMcpSignIn: "wisp:mcp:sign-in",
  cancelMcpSignIn: "wisp:mcp:sign-in:cancel",
  finishMcpSignIn: "wisp:mcp:sign-in:finish",
  mcpSettingsChanged: "wisp:mcp:changed",
  getWispMcpAccess: "wisp:mcp:access:get",
  saveWispMcpAccess: "wisp:mcp:access:save",
  saveAiSettings: "wisp:settings:ai:save",
  saveAuxiliaryModel: "wisp:settings:ai:save-auxiliary",
  saveFallbackModel: "wisp:settings:ai:save-fallback",
  removeProviderCredential: "wisp:settings:ai:remove-credential",
  startProviderSignIn: "wisp:settings:ai:sign-in",
  cancelProviderSignIn: "wisp:settings:ai:sign-in:cancel",
  finishProviderSignIn: "wisp:settings:ai:sign-in:finish",
  getConversationState: "wisp:conversations:get",
  initializeConversations: "wisp:conversations:initialize",
  createWisp: "wisp:wisps:create",
  updateWisp: "wisp:wisps:update",
  deleteWisp: "wisp:wisps:delete",
  wispsChanged: "wisp:wisps:changed",
  createConversation: "wisp:conversations:create",
  updateConversation: "wisp:conversations:update",
  deleteConversation: "wisp:conversations:delete",
  appendConversationMessage: "wisp:conversations:append-message",
  answerConversationPrompt: "wisp:conversations:answer-prompt",
  markConversationRead: "wisp:conversations:mark-read",
  markConversationUnread: "wisp:conversations:mark-unread",
  conversationChanged: "wisp:conversations:changed",
  getConversationMessages: "wisp:conversations:get-messages",
  searchMessages: "wisp:conversations:search",
  getScheduledMessages: "wisp:scheduled-messages:get",
  scheduleMessage: "wisp:scheduled-messages:create",
  updateScheduledMessage: "wisp:scheduled-messages:update",
  cancelScheduledMessage: "wisp:scheduled-messages:cancel",
  sendScheduledMessageNow: "wisp:scheduled-messages:send-now",
  scheduledMessagesChanged: "wisp:scheduled-messages:changed",
  getMessageQueue: "wisp:message-queue:get",
  queueMessage: "wisp:message-queue:add",
  updateQueuedMessage: "wisp:message-queue:update",
  cancelQueuedMessage: "wisp:message-queue:cancel",
  messageQueueChanged: "wisp:message-queue:changed",
  getJobs: "wisp:jobs:get",
  getJobRuns: "wisp:jobs:get-runs",
  pauseJob: "wisp:jobs:pause",
  resumeJob: "wisp:jobs:resume",
  runJobNow: "wisp:jobs:run-now",
  deleteJob: "wisp:jobs:delete",
  setJobMemory: "wisp:jobs:set-memory",
  jobsChanged: "wisp:jobs:changed",
  getSessionReport: "wisp:conversations:get-session-report",
  getUsageReport: "wisp:usage:get",
  getToolPolicy: "wisp:tool-policy:get",
  getUserProfile: "wisp:profile:get",
  saveUserProfile: "wisp:profile:save",
  setUserTimeZone: "wisp:time-zone:set",
  saveToolPolicy: "wisp:tool-policy:save",
  resolveToolApproval: "wisp:tool-policy:resolve-approval",
  getWispToolPolicy: "wisp:tool-policy:get-wisp",
  saveWispToolPolicy: "wisp:tool-policy:save-wisp",
  getLaunchAtLoginState: "wisp:login:get",
  setLaunchAtLogin: "wisp:login:set",
  getUpdateState: "wisp:update:get-state",
  checkForUpdates: "wisp:update:check",
  downloadUpdate: "wisp:update:download",
  installUpdate: "wisp:update:install",
  openReleasesPage: "wisp:update:open-releases",
  updateState: "wisp:update:state",
  getWorkspace: "wisp:workspace:get",
  setWorkspaceQuota: "wisp:workspace:set-quota",
  getWispExecution: "wisp:execution:get",
  saveWispExecution: "wisp:execution:save",
  getWispSetup: "wisp:execution:setup",
  openWorkspaceFolder: "wisp:workspace:open",
  openSkillsFolder: "wisp:workspace:open-skills",
  attachWorkspaceFiles: "wisp:workspace:attach",
  searchWorkspaceFiles: "wisp:workspace:search-files",
  getStorageSummary: "wisp:storage:summary",
  listStorageDirectory: "wisp:storage:list",
  prepareStorageCleanup: "wisp:storage:prepare-cleanup",
  cleanStorage: "wisp:storage:clean",
  deleteArchivedStorage: "wisp:storage:delete-archives",
  listSkills: "wisp:skills:list",
  deleteSkill: "wisp:skills:delete",
  importSkill: "wisp:skills:import",
  getMemory: "wisp:memory:get",
  applyMemory: "wisp:memory:apply",
  exportMemory: "wisp:memory:export",
  getVoiceSettings: "wisp:voice:get",
  saveVoiceCredential: "wisp:voice:save-credential",
  removeVoiceCredential: "wisp:voice:remove-credential",
  transcribeAudio: "wisp:voice:transcribe",
  getConnections: "wisp:connections:get",
  saveConnection: "wisp:connections:save",
  testSshConnection: "wisp:connections:test-ssh",
  removeConnection: "wisp:connections:remove",
  activateConnection: "wisp:connections:activate",
  retryConnection: "wisp:connections:retry",
  installServer: "wisp:connections:install-server",
  cancelServerInstall: "wisp:connections:cancel-server-install",
  cancelConnection: "wisp:connections:cancel",
  answerSshPrompt: "wisp:connections:answer-ssh-prompt",
  connectionsChanged: "wisp:connections:changed",
  getRemoteAccess: "wisp:remote-access:get",
  saveRemoteAccess: "wisp:remote-access:save",
  pairRemoteDevice: "wisp:remote-access:pair",
  revokeRemoteDevice: "wisp:remote-access:revoke",
  configureSystemNotifications: "wisp:system-notifications:configure",
  setNotificationFocus: "wisp:system-notifications:set-focus",
  testSystemNotification: "wisp:system-notifications:test",
  takeNotificationTarget: "wisp:system-notifications:take-target",
  openNotificationTarget: "wisp:system-notifications:open",
} as const;

export const WISP_REPOSITORY_URL = "https://github.com/gustmrg/wisp-bot";
export const WISP_RELEASES_URL = `${WISP_REPOSITORY_URL}/releases/latest`;

export interface ConversationRequest {
  conversationId: string;
}

export interface SendMessageRequest extends ConversationRequest {
  requestId: string;
  text: string;
  /** Set by the backend when it sends a scheduled message; never accepted from a client. */
  scheduled?: import("./conversations.js").ScheduledOrigin;
}

export interface SetUserTimeZoneRequest {
  /** An IANA time zone such as "America/Sao_Paulo". */
  timeZone: string;
}

/** How much a reasoning model thinks before answering, from Pi's thinking levels. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as ReadonlyArray<string>).includes(value);
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  maxOutputTokens?: number;
  /** Absent means "off": the model answers without reasoning. */
  thinkingLevel?: ThinkingLevel;
}

export interface ModelSummary {
  id: string;
  name: string;
  reasoning: boolean;
  /** The levels this model supports, in increasing order; "off" is missing when it cannot stop reasoning. */
  thinkingLevels: ReadonlyArray<ThinkingLevel>;
  input: ReadonlyArray<"text" | "image">;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProviderSummary {
  id: string;
  name: string;
  credentialConfigured: boolean;
  /**
   * How the saved credential pays for requests: an API key billed per token,
   * or a sign-in billed to the person's subscription. Missing without one.
   */
  credentialKind?: "api_key" | "subscription";
  /** Set when the provider can be used through a subscription sign-in, with its button label. */
  subscriptionSignIn?: { label: string };
  models: ReadonlyArray<ModelSummary>;
}

/** A provider subscription sign-in that is open, or the last one that failed. */
export interface ProviderSignInView {
  providerId: string;
  status: "waiting" | "failed";
  /**
   * While waiting on a device whose browser cannot reach the server: the page
   * to open there. The person then pastes the address the browser lands on.
   */
  signInUrl?: string;
  /** Why the sign-in failed. */
  error?: string;
}

/** Tasks a separately chosen model does for Wisps whose own model cannot. */
export type AuxiliaryTask = "imageUnderstanding";

export type AuxiliaryModelSelections = Record<AuxiliaryTask, ModelSelection | null>;

/** Why a saved auxiliary model is not used. The selection is kept so the person can see and fix it. */
export type AuxiliaryModelUnavailableReason = "missing_key" | "model_unavailable" | "no_image_input";

export interface AuxiliaryModelView {
  selection: ModelSelection | null;
  /** Set when a saved selection cannot be used; the task is then off. */
  unavailable: AuxiliaryModelUnavailableReason | null;
}

/**
 * Why a saved fallback model is not used. The selection is kept so the person
 * can see and fix it. `same_provider` is a fallback from the provider of the
 * model it stands in for, which fails along with it.
 */
export type FallbackModelUnavailableReason = "missing_key" | "model_unavailable" | "same_provider";

export interface FallbackModelView {
  selection: ModelSelection | null;
  /** Set when a saved selection cannot be used; there is then no fallback. */
  unavailable: FallbackModelUnavailableReason | null;
}

/**
 * What a Wisp answers with when its model fails for good, such as when the
 * provider is out of credits: nothing, the global fallback model, or a model
 * of its own. A fallback names a provider and model only.
 */
export type WispFallback = "off" | "global" | ModelSelection;

/**
 * A Wisp's fallback choice. One that never chose follows its model: a Wisp on
 * the global model uses the global fallback, and one with its own model has
 * none until the person turns it on.
 */
export function wispFallbackChoice(modelOverride: ModelSelection | null, saved: WispFallback | null): WispFallback {
  return saved ?? (modelOverride ? "off" : "global");
}

export interface AiSettingsView {
  selection: ModelSelection | null;
  auxiliary: Record<AuxiliaryTask, AuxiliaryModelView>;
  /** The model Wisps on the global model answer with when it fails for good. */
  fallback: FallbackModelView;
  secureStorageAvailable: boolean;
  providers: ReadonlyArray<ProviderSummary>;
  /** A subscription sign-in in progress or the last one that failed; missing from servers before sign-ins. */
  providerSignIn?: ProviderSignInView | null;
  /** Whether this server's Claude Code can run Wisps (ADR 026); missing from servers before Claude Code. */
  claudeCode?: ClaudeCodeStatusView;
  /** Set when the model catalog could not be fully loaded or refreshed and the built-in list is shown. */
  catalogError: string | null;
}

export interface SaveAiSettingsRequest {
  selection: ModelSelection;
  apiKey?: string;
}

export interface SaveAuxiliaryModelRequest {
  task: AuxiliaryTask;
  /** Null turns the task off. */
  selection: ModelSelection | null;
}

export interface SaveFallbackModelRequest {
  /** Null turns the global fallback off. */
  selection: ModelSelection | null;
}

export interface RemoveProviderCredentialRequest {
  providerId: string;
}

export interface ProviderSignInRequest {
  providerId: string;
}

export interface FinishProviderSignInRequest {
  providerId: string;
  /** The address the browser was sent to after the sign-in. */
  redirectUrl: string;
}

export interface ApplyModelRequest extends ConversationRequest {
  model: ModelSelection | null;
}

export interface ApplyFallbackModelRequest extends ConversationRequest {
  fallback: WispFallback;
}

export interface ConversationModelView {
  override: ModelSelection | null;
  effective: ModelSelection | null;
  applied: ModelSelection | null;
  pending: ModelSelection | null;
  /** The Wisp's fallback choice; a Wisp that never chose has the default for its model. */
  fallback: WispFallback;
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

/** What a Stop gave back: follow-ups handed to the stopped turn that it never read, oldest first. */
export interface AbortConversationView {
  followUps: ReadonlyArray<QueuedMessage>;
}

export type ConversationStatus = "configuration_required" | "idle" | "working" | "disposed";

export type TurnItemStatus = "running" | "completed" | "failed" | "cancelled";

export type BackgroundProcessAction = "start" | "list" | "log" | "wait" | "kill";

/**
 * What a Wisp did with one tool call, as the conversation shows it. The
 * backend reads it from the call's arguments and result, the same way on
 * every runtime; secrets are masked and long text is cut before it leaves.
 */
export type TurnItem = {
  /** The tool call's ID. */
  id: string;
  toolName: string;
  status: TurnItemStatus;
  startedAt: string;
  completedAt?: string;
  /** The tool's own progress text while it runs. */
  label?: string;
} & (
  | {
      type: "command_execution";
      command: string;
      /** What the Wisp said the command is for. */
      purpose?: string;
      exitCode?: number;
      /** The end of the output. */
      output?: string;
      outputTruncated?: boolean;
    }
  | {
      type: "background_process";
      action: BackgroundProcessAction;
      processId?: string;
      /** Set for `start`. */
      command?: string;
      /** How the process stood after the call, such as `running` or `exited`. */
      state?: string;
      output?: string;
      outputTruncated?: boolean;
    }
  | {
      type: "file_change";
      /** Relative to the workspace when inside it. */
      path: string;
      additions?: number;
      deletions?: number;
      /** The unified patch, from its start. */
      diff?: string;
      diffTruncated?: boolean;
    }
  | { type: "file_read"; paths: string[] }
  | { type: "file_search"; pattern: string; path?: string }
  | { type: "web_search"; query: string }
  | { type: "web_read"; url: string }
  | {
      type: "browser";
      action: string;
      /** The page the browser was on after the call. */
      url?: string;
      pageTitle?: string;
    }
  | { type: "tool" }
);

/**
 * What a conversation's agent reports. In a circle, events about one member's
 * turn name it with `wispId` (ADR 011); in a Wisp's own conversation they are
 * that Wisp's.
 */
export type ConversationAgentEvent = ConversationAgentEventBody & { wispId?: string };

type ConversationAgentEventBody =
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
      /** The fallback model's name, set when it answered because the Wisp's model failed. */
      fallbackModel?: string;
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
      /** A tool call started, made progress, or ended; `item` is all of it so far and replaces what came before. */
      type: "turn_item";
      conversationId: string;
      requestId: string;
      /** The steps between two parts of the reply share it; see `workMessageId`. */
      groupId: string;
      item: TurnItem;
    }
  | {
      type: "conversation_notice";
      conversationId: string;
      requestId?: string;
      kind: "retry_started" | "retry_finished" | "compaction_started" | "compaction_finished" | "fallback_started";
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
      decision: "allow_once" | "allow_always" | "allow_integration" | "deny" | "block" | "expired";
    }
  | {
      /**
       * The running turn read a follow-up the person sent while it worked. The
       * reply to `requestId` ends here, the follow-up joins the transcript, and
       * the rest of the turn answers it as `followUpId`.
       */
      type: "follow_up_taken";
      conversationId: string;
      requestId: string;
      followUpId: string;
    }
  | {
      /** A job's run added its message to the conversation; it notifies like a reply. */
      type: "job_message_delivered";
      conversationId: string;
      jobId: string;
      messageId: string;
    }
  | {
      /** In a circle, a member's turn for the person's message `requestId` started (ADR 011). */
      type: "circle_turn_started";
      conversationId: string;
      requestId: string;
      wispId: string;
    };

export type SequencedConversationAgentEvent = ConversationAgentEvent & { sequence: number };

export interface SessionReportUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/**
 * Token totals with estimated USD. `cacheSavingsUsd` is what cache reads saved
 * against paying full input price, net of the premium some providers charge to
 * write the cache; null when a model with cache traffic has no price.
 */
export type SessionReportTotals = SessionReportUsage & { costUsd: number | null; cacheSavingsUsd: number | null };

export interface SessionReportModelUsage {
  providerId: string;
  modelId: string;
  turns: number;
  usage: SessionReportUsage;
  costUsd: number | null;
  /** What reading from the cache saved; null when the model's price is unknown. Absent from older servers. */
  cacheSavingsUsd?: number | null;
  /** Set on a row for an auxiliary model, which runs calls for the Wisp rather than turns. */
  auxiliary?: { task: AuxiliaryTask; calls: number };
  /** Set on a row for turns a Claude plan paid for (ADR 026), which cost nothing more. */
  plan?: true;
}

export interface SessionReportToolCall {
  toolCallId: string;
  toolName: string;
  /** A readable name for the tool, with the connection it came from for MCP tools; absent from older servers. */
  toolLabel?: string;
  argumentSummary: string;
  /** For commands: the programs run, without their arguments (`git clone · npm install`). */
  commandOutline?: string;
  /** For commands: what the Wisp said the command was for. */
  purpose?: string;
  /** For commands: how the command ended. */
  commandResult?: { exitCode?: number; durationMs?: number; stopped?: "timeout" | "aborted" };
  status: "completed" | "error" | "pending";
  timestamp: string;
  /** The image model that read images or scanned pages for this call; `fromCache` when nothing was sent again. */
  imageModel?: { name: string; fromCache: boolean };
}

export interface SessionReportEvent {
  kind: "compaction" | "error" | "retry_started" | "retry_finished" | "fallback";
  timestamp: string;
  detail: string;
}

export interface WispSessionReport {
  compactionUsage?: SessionReportUsage;
  /** The cost recorded for `compactionUsage`, whose model is not recorded; null when unknown. */
  compactionCostUsd?: number | null;
  /** Tokens used by auxiliary models, such as the image model; included in the totals. */
  auxiliaryUsage?: SessionReportUsage;
  sessionId: string;
  generatedAt: string;
  piVersion?: string;
  turns: number;
  totals: SessionReportTotals;
  models: ReadonlyArray<SessionReportModelUsage>;
  toolCalls: ReadonlyArray<SessionReportToolCall>;
  events: ReadonlyArray<SessionReportEvent>;
}

export type UsagePeriod = "7d" | "30d" | "all";

export interface UsageReportRequest {
  period: UsagePeriod;
  /** A circle: only its members' usage in it, one row per member, keyed by the Wisp's ID. */
  conversationId?: string;
}

export interface WispUsageRow {
  conversationId: string;
  name: string;
  sessions: number;
  totals: SessionReportTotals;
  /** The same usage split by model; together the rows add up to `totals`. Absent from older servers. */
  models?: ReadonlyArray<ModelUsageRow>;
}

/** One model's usage in a usage report, or context summaries, whose model is not recorded. */
export interface ModelUsageRow {
  /** `provider:model`, prefixed `plan:` for turns a Claude plan paid for; `compaction` for context summaries. */
  key: string;
  kind: "model" | "compaction";
  providerId: string | null;
  modelId: string | null;
  /** Turns a Claude plan paid for (ADR 026), which cost nothing more. */
  plan?: true;
  turns: number;
  /** Calls the model made as an auxiliary model, such as reading an image for a Wisp. */
  auxiliaryCalls: number;
  totals: SessionReportTotals;
}

export interface UsageReport {
  generatedAt: string;
  from: string | null;
  period: UsagePeriod;
  pricingUpdatedAt: string | null;
  incomplete: boolean;
  wisps: ReadonlyArray<WispUsageRow>;
  totals: SessionReportTotals;
  /** Every Wisp's usage split by model, adding up to `totals`. Absent from older servers. */
  models?: ReadonlyArray<ModelUsageRow>;
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

/** What a native notification is about; the same events notification sounds play for. */
export type SystemNotificationKind = "finished" | "needs-input" | "error";

/** Which Wisp updates show a native notification. */
export interface SystemNotificationSettings {
  enabled: boolean;
  onCompletion: boolean;
  onApproval: boolean;
  onError: boolean;
}

/** The conversation open in the app, and whether its window has focus: its updates need no notification. */
export interface NotificationFocusRequest {
  conversationId: string | null;
}

export interface TestSystemNotificationRequest {
  kind: SystemNotificationKind;
}

/** Where clicking a native notification takes the person. */
export interface SystemNotificationTarget {
  conversationId: string;
  approvalId?: string;
}

/** Native notifications and the dock or taskbar badge. Desktop app only. */
export interface SystemNotificationsApi {
  configure(settings: SystemNotificationSettings): Promise<EmptyResult>;
  setFocus(request: NotificationFocusRequest): Promise<EmptyResult>;
  /** Shows a sample notification, whatever the settings say. */
  test(request: TestSystemNotificationRequest): Promise<EmptyResult>;
  /**
   * Calls `listener` when the person clicks a notification, including one
   * clicked while no window was open, which opened this one.
   */
  subscribeToOpen(listener: (target: SystemNotificationTarget) => void): () => void;
}

export interface WispApi {
  getLaunchAtLoginState(): Promise<BackendResult<LaunchAtLoginState>>;
  setLaunchAtLogin(enabled: boolean): Promise<BackendResult<LaunchAtLoginState>>;
  getPluginSettings(): Promise<BackendResult<PluginSettingsView>>;
  savePluginSettings(request: SavePluginSettingsRequest): Promise<BackendResult<PluginSettingsView>>;
  savePluginDefaults(request: SavePluginDefaultsRequest): Promise<BackendResult<PluginSettingsView>>;
  removePlugin(request: PluginRequest): Promise<BackendResult<PluginSettingsView>>;
  testPluginConnection(request: TestPluginConnectionRequest): Promise<BackendResult<PluginConnectionResult>>;
  startPluginSignIn(request: StartPluginSignInRequest): Promise<BackendResult<PluginSettingsView>>;
  cancelPluginSignIn(request: PluginRequest): Promise<BackendResult<PluginSettingsView>>;
  finishPluginSignIn(request: FinishPluginSignInRequest): Promise<BackendResult<PluginSettingsView>>;
  subscribeToPluginSettings(listener: (view: PluginSettingsView) => void): () => void;
  getWispPluginAccess(request: ConversationRequest): Promise<BackendResult<WispPluginAccessView>>;
  saveWispPluginAccess(request: SaveWispPluginAccessRequest): Promise<BackendResult<WispPluginAccessView>>;
  getMcpSettings(): Promise<BackendResult<McpSettingsView>>;
  saveMcpServer(request: SaveMcpServerRequest): Promise<BackendResult<McpSettingsView>>;
  removeMcpServer(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  testMcpConnection(request: TestMcpConnectionRequest): Promise<BackendResult<McpConnectionResult>>;
  refreshMcpTools(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  startMcpSignIn(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  cancelMcpSignIn(request: McpServerRequest): Promise<BackendResult<McpSettingsView>>;
  finishMcpSignIn(request: FinishMcpSignInRequest): Promise<BackendResult<McpSettingsView>>;
  getWispMcpAccess(request: ConversationRequest): Promise<BackendResult<WispMcpAccessView>>;
  saveWispMcpAccess(request: SaveWispMcpAccessRequest): Promise<BackendResult<WispMcpAccessView>>;
  subscribeToMcpSettings(listener: (view: McpSettingsView) => void): () => void;
  manageContext(request: ContextRequest): Promise<BackendResult<ContextView>>;
  startConversation(request: ConversationRequest): Promise<EmptyResult>;
  sendMessage(request: SendMessageRequest): Promise<EmptyResult>;
  abortConversation(request: ConversationRequest): Promise<BackendResult<AbortConversationView>>;
  applyModel(request: ApplyModelRequest): Promise<EmptyResult>;
  applyFallbackModel(request: ApplyFallbackModelRequest): Promise<EmptyResult>;
  getConversationModel(request: ConversationRequest): Promise<BackendResult<ConversationModelView>>;
  disposeConversation(request: ConversationRequest): Promise<EmptyResult>;
  subscribeToAgentEvents(listener: (event: SequencedConversationAgentEvent) => void): () => void;
  getAiSettings(): Promise<BackendResult<AiSettingsView>>;
  saveAiSettings(request: SaveAiSettingsRequest): Promise<BackendResult<AiSettingsView>>;
  saveAuxiliaryModel(request: SaveAuxiliaryModelRequest): Promise<BackendResult<AiSettingsView>>;
  saveFallbackModel(request: SaveFallbackModelRequest): Promise<BackendResult<AiSettingsView>>;
  removeProviderCredential(request: RemoveProviderCredentialRequest): Promise<BackendResult<AiSettingsView>>;
  startProviderSignIn(request: ProviderSignInRequest): Promise<BackendResult<AiSettingsView>>;
  cancelProviderSignIn(request: ProviderSignInRequest): Promise<BackendResult<AiSettingsView>>;
  finishProviderSignIn(request: FinishProviderSignInRequest): Promise<BackendResult<AiSettingsView>>;
  getConversationState(): Promise<BackendResult<ConversationStateView>>;
  initializeConversations(request: InitializeConversationsRequest): Promise<BackendResult<ConversationStateView>>;
  createWisp(request: CreateWispRequest): Promise<BackendResult<ConversationStateView>>;
  updateWisp(request: UpdateWispRequest): Promise<BackendResult<ConversationStateView>>;
  deleteWisp(request: DeleteWispRequest): Promise<BackendResult<ConversationStateView>>;
  createConversation(request: CreateConversationRequest): Promise<BackendResult<ConversationStateView>>;
  updateConversation(request: UpdateConversationRequest): Promise<BackendResult<ConversationStateView>>;
  deleteConversation(request: DeleteConversationRequest): Promise<BackendResult<ConversationStateView>>;
  // Single-chat changes return only what changed; structural changes above return the full state.
  appendConversationMessage(request: AppendConversationMessageRequest): Promise<BackendResult<ConversationDelta>>;
  answerConversationPrompt(request: AnswerConversationPromptRequest): Promise<BackendResult<ConversationDelta>>;
  markConversationRead(request: MarkConversationReadRequest): Promise<BackendResult<ConversationDelta>>;
  markConversationUnread(request: MarkConversationUnreadRequest): Promise<BackendResult<ConversationDelta>>;
  /** One page of a transcript, read from the backend store. */
  getConversationMessages(request: MessagePageRequest): Promise<BackendResult<MessagePage>>;
  /** Newest matching messages first. The query must have at least 3 characters. */
  searchMessages(request: SearchMessagesRequest): Promise<BackendResult<ReadonlyArray<MessageSearchHit>>>;
  /** Pushes what changed after the backend persists agent-driven changes (replies, statuses, context notices). */
  subscribeToConversationChanges(listener: (delta: ConversationDelta) => void): () => void;
  /** Pushes the Wisps and conversation summaries after a Wisp was created, changed or deleted, by anyone. */
  subscribeToWisps(listener: (view: WispsView) => void): () => void;
  /** Every scheduled message, soonest first. */
  getScheduledMessages(): Promise<BackendResult<ScheduledMessagesView>>;
  /** Schedules a message the backend sends to a Wisp later, even with no app open. */
  scheduleMessage(request: ScheduleMessageRequest): Promise<BackendResult<ScheduledMessagesView>>;
  updateScheduledMessage(request: UpdateScheduledMessageRequest): Promise<BackendResult<ScheduledMessagesView>>;
  cancelScheduledMessage(request: ScheduledMessageRequest): Promise<BackendResult<ScheduledMessagesView>>;
  /** Sends a scheduled message's next occurrence now; a one-off message is then done. */
  sendScheduledMessageNow(request: ScheduledMessageRequest): Promise<BackendResult<ScheduledMessagesView>>;
  /** Pushes every scheduled message after any change, including sends. */
  subscribeToScheduledMessages(listener: (view: ScheduledMessagesView) => void): () => void;
  /** Every job of every Wisp, soonest next run first (ADR 019). */
  getJobs(): Promise<BackendResult<JobsView>>;
  /** A job's recent runs, newest first. */
  getJobRuns(request: JobRequest): Promise<BackendResult<JobRunsView>>;
  pauseJob(request: JobRequest): Promise<BackendResult<JobsView>>;
  /** Resumes from now: occurrences missed while paused do not run. */
  resumeJob(request: JobRequest): Promise<BackendResult<JobsView>>;
  /** Runs a job now without changing its schedule. */
  runJobNow(request: JobRequest): Promise<BackendResult<JobsView>>;
  /** Deletes a job with its runs. */
  deleteJob(request: JobRequest): Promise<BackendResult<JobsView>>;
  /** Whether the job's next runs read the Wisp's memory; they do not by default. */
  setJobMemory(request: SetJobMemoryRequest): Promise<BackendResult<JobsView>>;
  /** Pushes every job after any change, including runs. */
  subscribeToJobs(listener: (view: JobsView) => void): () => void;
  /** Every message waiting for its Wisp, oldest first. */
  getMessageQueue(): Promise<BackendResult<MessageQueueView>>;
  /**
   * Sends a message: it waits in the queue until the Wisp is free, then joins
   * the transcript right before the reply to it.
   */
  queueMessage(request: QueueMessageRequest): Promise<BackendResult<MessageQueueView>>;
  updateQueuedMessage(request: UpdateQueuedMessageRequest): Promise<BackendResult<MessageQueueView>>;
  cancelQueuedMessage(request: QueuedMessageRequest): Promise<BackendResult<MessageQueueView>>;
  /** Pushes every queued message after any change, including a Wisp taking one. */
  subscribeToMessageQueue(listener: (view: MessageQueueView) => void): () => void;
  getSessionReport(request: ConversationRequest): Promise<BackendResult<WispSessionReport | null>>;
  getUsageReport(request: UsageReportRequest): Promise<BackendResult<UsageReport>>;
  getToolPolicy(): Promise<BackendResult<ToolPolicySettings>>;
  getUserProfile(): Promise<BackendResult<import("./user-profile.js").UserProfile>>;
  saveUserProfile(
    profile: import("./user-profile.js").UserProfile,
  ): Promise<BackendResult<import("./user-profile.js").UserProfile>>;
  /** Tells the server which time zone the person is in, so Wisps know their local time. */
  setUserTimeZone(request: SetUserTimeZoneRequest): Promise<EmptyResult>;
  saveToolPolicy(settings: ToolPolicySettings): Promise<BackendResult<ToolPolicySettings>>;
  resolveToolApproval(request: ResolveToolApprovalRequest): Promise<EmptyResult>;
  /** What this Wisp may do without asking (ADR 023). */
  getWispToolPolicy(request: ConversationRequest): Promise<BackendResult<WispToolPolicyView>>;
  saveWispToolPolicy(request: SaveWispToolPolicyRequest): Promise<BackendResult<WispToolPolicyView>>;
  getUpdateState(): Promise<BackendResult<UpdateState>>;
  checkForUpdates(): Promise<BackendResult<UpdateState>>;
  downloadUpdate(): Promise<BackendResult<UpdateState>>;
  installUpdate(): Promise<EmptyResult>;
  openReleasesPage(): Promise<EmptyResult>;
  subscribeToUpdateState(listener: (state: UpdateState) => void): () => void;
  getWorkspace(request: ConversationRequest): Promise<BackendResult<WorkspaceView>>;
  /** Resizes a Wisp's workspace. Shrinking below what it holds deletes nothing; it only stops new files. */
  setWorkspaceQuota(request: SetWorkspaceQuotaRequest): Promise<BackendResult<WorkspaceView>>;
  /** Where the Wisp's commands run, and whether the server can run them. */
  getWispExecution(request: ConversationRequest): Promise<BackendResult<WispExecutionView>>;
  saveWispExecution(request: SaveWispExecutionRequest): Promise<BackendResult<WispExecutionView>>;
  /** Workspace room and command support for a Wisp that does not exist yet. */
  getWispSetup(): Promise<BackendResult<WispSetupView>>;
  openWorkspaceFolder(request: ConversationRequest): Promise<EmptyResult>;
  /** Opens the Wisp's skills folder, creating it on first use. */
  openSkillsFolder(request: ConversationRequest): Promise<EmptyResult>;
  /**
   * Shows a native file picker and copies the chosen files into the Wisp's workspace inbox. `options` stay
   * in the page: only a browser sending files itself reports progress and can be cancelled.
   */
  attachWorkspaceFiles(
    request: ConversationRequest,
    options?: AttachWorkspaceFilesOptions,
  ): Promise<BackendResult<AttachWorkspaceFilesResult>>;
  /** The files in a Wisp's workspace best matching what follows an `@`, for mentioning them in a message. */
  searchWorkspaceFiles(request: SearchWorkspaceFilesRequest): Promise<BackendResult<WorkspaceFileSearch>>;
  /** Space used by every workspace and archived conversation on the active connection. */
  getStorageSummary(request: StorageSummaryRequest): Promise<BackendResult<StorageSummary>>;
  /** One page of a workspace folder's entries, largest first. */
  listStorageDirectory(request: StorageDirectoryRequest): Promise<BackendResult<StorageDirectoryPage>>;
  /** Measures what removing the paths would delete, without deleting anything. */
  prepareStorageCleanup(request: StorageCleanupRequest): Promise<BackendResult<StorageCleanupPreview>>;
  /** Permanently deletes previewed paths; refused when they changed since the preview. */
  cleanStorage(request: StorageCleanupConfirmation): Promise<BackendResult<StorageCleanupResult>>;
  /** Permanently deletes archived conversations, including their workspace, sessions and settings. */
  deleteArchivedStorage(request: StorageArchiveDeletionRequest): Promise<BackendResult<StorageArchiveDeletionResult>>;
  /** The Wisp's saved skills, alphabetically; malformed skill files are left out. */
  listSkills(request: ConversationRequest): Promise<BackendResult<ReadonlyArray<SkillView>>>;
  deleteSkill(request: SkillRequest): Promise<BackendResult<ReadonlyArray<SkillView>>>;
  /** Saves a SKILL.md the user picked, without going through the Wisp, and returns the updated list. */
  importSkill(request: ImportSkillRequest): Promise<BackendResult<ReadonlyArray<SkillView>>>;
  /**
   * The memory a Wisp sees: the person's entries and its own, in every status (ADR 029).
   * Without a conversation, the person's own: the entries every Wisp shares.
   */
  getMemory(request: import("./memory.js").MemoryRequest): Promise<BackendResult<import("./memory.js").MemoryView>>;
  /** Applies the person's changes in one transaction and returns the memory as it is after them. */
  applyMemory(
    request: import("./memory.js").ApplyMemoryRequest,
  ): Promise<BackendResult<import("./memory.js").MemoryView>>;
  /** One scope's active entries as a Markdown file: USER.md, or the Wisp's MEMORY.md. */
  exportMemory(
    request: import("./memory.js").ExportMemoryRequest,
  ): Promise<BackendResult<import("./memory.js").MemoryExport>>;
  /** Which voice providers have a saved key; keys themselves never leave the backend. */
  getVoiceSettings(): Promise<BackendResult<VoiceSettingsView>>;
  /**
   * Saves a provider key for voice input. Chat models of the same provider use
   * it too, unless they use a subscription sign-in, which the key leaves alone.
   */
  saveVoiceCredential(request: SaveVoiceCredentialRequest): Promise<BackendResult<VoiceSettingsView>>;
  /** Removes the key voice input uses for a provider, never a subscription sign-in. */
  removeVoiceCredential(request: RemoveVoiceCredentialRequest): Promise<BackendResult<VoiceSettingsView>>;
  /** Sends a recording to the chosen speech-to-text provider and returns its text. */
  transcribeAudio(request: TranscribeAudioRequest): Promise<BackendResult<TranscriptionResult>>;
  getConnections(): Promise<BackendResult<ConnectionsView>>;
  testSshConnection(request: SaveConnectionRequest): Promise<BackendResult<{ message: string }>>;
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
  /** Stops connecting to the active server; it shows as cancelled until retried. */
  cancelConnection(): Promise<BackendResult<ConnectionsView>>;
  /** Answers the question OpenSSH asks while connecting, shown in `ConnectionsView.sshPrompt`. */
  answerSshPrompt(request: AnswerSshPromptRequest): Promise<BackendResult<ConnectionsView>>;
  subscribeToConnections(listener: (view: ConnectionsView) => void): () => void;
  /** Remote access to Wisps on this computer, with the devices paired with them. Desktop app only. */
  getRemoteAccess(): Promise<BackendResult<RemoteAccessView>>;
  /** Turns remote access on or off, or changes its port or origin; Wisps on this computer restart. */
  saveRemoteAccess(request: SaveRemoteAccessRequest): Promise<BackendResult<RemoteAccessView>>;
  /** A one-time pairing code and link for a new device, while remote access is on. */
  pairRemoteDevice(): Promise<BackendResult<RemoteAccessPairing>>;
  /** Removes a device paired with Wisps on this computer and ends its sessions. */
  revokeRemoteDevice(request: RevokeRemoteDeviceRequest): Promise<BackendResult<RemoteAccessView>>;
  /** Absent in the browser app, which has no native notifications. */
  systemNotifications?: SystemNotificationsApi;
}
