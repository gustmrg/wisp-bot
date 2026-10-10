import path from "node:path";

import type { ModelSelection, SequencedConversationAgentEvent } from "../shared/contracts.js";
import type { ConversationDelta } from "../shared/conversations.js";
import type { McpSettingsView } from "../shared/mcp.js";
import type { MessageQueueView } from "../shared/message-queue.js";
import type { ScheduledMessagesView } from "../shared/scheduled-messages.js";
import type { AgentMode } from "./agent-mode.js";
import { AgentRegistry } from "./agent-registry.js";
import { sanitizeBackendError } from "./backend-error.js";
import type { ConversationAgentFactory } from "./conversation-agent.js";
import { ConversationRepository } from "./conversation-repository.js";
import { ConversationService } from "./conversation-service.js";
import type { EncryptionService } from "./encrypted-credential-store.js";
import { FakeConversationAgentFactory } from "./fake-conversation-agent.js";
import { CompositeIntegrationToolSource } from "./integration-tool-source.js";
import { McpService } from "./mcp-service.js";
import { MessageQueue } from "./message-queue.js";
import { MessageScheduler } from "./message-scheduler.js";
import { ModelPricingService } from "./model-pricing-service.js";
import { ModelService } from "./model-service.js";
import { PiConversationAgentFactory, SdkPiSessionFactory } from "./pi-conversation-agent.js";
import { PluginService } from "./plugin-service.js";
import { SessionReportService } from "./session-report-service.js";
import type { StructuredLogger } from "./structured-logger.js";
import { ToolAuditStore } from "./tool-audit-store.js";
import { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { fakeTranscriptionFetch, TranscriptionService } from "./transcription-service.js";
import { StorageService } from "./storage-service.js";
import { readWorkspaceQuota, WorkspaceService } from "./workspace-service.js";
import { ContainerRuntimeDetector, type ContainerCli } from "./container-cli.js";
import { ContainerManager } from "./container-manager.js";
import { ExecutionService } from "./execution-service.js";

/** Host capabilities the runtime needs, injected so any host (desktop or server) can compose it. */
export interface BackendRuntimeOptions {
  /** Root for every backend store: conversations, sessions, credentials, and policy. */
  dataDirectory: string;
  encryption: EncryptionService;
  logger: StructuredLogger;
  agentMode: AgentMode;
  /** The running application version, reported to remote MCP servers. */
  appVersion: string;
  userName?: string;
  /** Refresh model catalogs over the network in the background after startup. Defaults to true. */
  allowModelNetwork?: boolean;
  /** The principal that should own a new tool approval prompt, or null when none can answer it. */
  selectApprovalWindowId: () => number | null;
  openExternal: (url: string) => Promise<void>;
  /** Opens a backend-owned local folder in the system file manager. */
  openPath: (directory: string) => Promise<void>;
  /** Shows a native multi-file picker; resolves with absolute paths, empty when dismissed. */
  selectFiles: () => Promise<ReadonlyArray<string>>;
  /** Receives every agent event after the conversation service has persisted it. */
  onAgentEvent: (event: SequencedConversationAgentEvent) => void;
  /** Receives what changed after agent-driven changes are persisted. */
  onConversationChanged: (delta: ConversationDelta) => void;
  /** Receives the sanitized MCP view after health or settings changes; secrets never leave the backend. */
  onMcpSettingsChanged: (view: McpSettingsView) => void;
  /** Receives every scheduled message after any change, including sends. */
  onScheduledMessagesChanged: (view: ScheduledMessagesView) => void;
  /** Receives every queued message after any change, including a Wisp taking one. */
  onMessageQueueChanged: (view: MessageQueueView) => void;
  /**
   * Container programs to look for, in order. Defaults to Docker then Podman;
   * the fake agent mode looks for none, since its Wisps never run commands.
   */
  containerPrograms?: ReadonlyArray<ContainerCli>;
}

/** The composed backend services, independent of any window or transport. */
export interface BackendRuntime {
  models: ModelService;
  toolAuthorization: ToolAuthorizationBroker;
  plugins: PluginService;
  mcp: McpService;
  registry: AgentRegistry;
  conversations: ConversationService;
  scheduledMessages: MessageScheduler;
  messageQueue: MessageQueue;
  sessionReports: SessionReportService;
  workspace: WorkspaceService;
  storage: StorageService;
  transcription: TranscriptionService;
  execution: ExecutionService;
  /** Validates and saves a single Wisp's model override; null clears it. */
  applyConversationModel(conversationId: string, model: ModelSelection | null): Promise<void>;
  /** Re-applies the saved global model, e.g. after a credential change made it usable. */
  reapplySavedModel(): Promise<void>;
  /** Rejects pending approvals, stops integrations, and disposes every agent before closing storage. */
  dispose(): Promise<void>;
}

export async function createBackendRuntime(options: BackendRuntimeOptions): Promise<BackendRuntime> {
  const { dataDirectory, encryption, logger } = options;
  const modelService = await ModelService.create({
    dataDirectory,
    encryption,
    ...(options.allowModelNetwork === undefined ? {} : { allowModelNetwork: options.allowModelNetwork }),
  });
  const toolPolicyStore = new ToolPolicyStore(path.join(dataDirectory, "tool-policy.json"));
  await toolPolicyStore.load();

  // The registry, broker, and conversation service reference each other through
  // events, so the late-bound ones are captured by these closures.
  let conversationService: ConversationService | undefined;
  let agentRegistry: AgentRegistry | undefined;
  let messageScheduler: MessageScheduler | undefined;
  let messageQueue: MessageQueue | undefined;
  let storageService: StorageService | undefined;
  const publishAgentEvent = (event: SequencedConversationAgentEvent): void => {
    conversationService?.handleAgentEvent(event);
    if (event.type === "conversation_error") {
      logger.warn("conversation_error", {
        conversationId: event.conversationId,
        requestId: event.requestId,
        code: event.error.code,
        retryable: event.error.retryable,
        message: event.error.message,
        ...(event.error.detail ? { detail: event.error.detail } : {}),
      });
    } else if (event.type === "tool_approval_requested" || event.type === "tool_approval_resolved") {
      logger.info(event.type, {
        conversationId: event.conversationId,
        approvalId: event.type === "tool_approval_requested" ? event.request.approvalId : event.approvalId,
      });
    }
    options.onAgentEvent(event);
  };
  const toolAuthorizationBroker = new ToolAuthorizationBroker(
    toolPolicyStore,
    (event) => agentRegistry?.publishExternalEvent(event),
    {
      selectWindowId: options.selectApprovalWindowId,
      audit: new ToolAuditStore(path.join(dataDirectory, "tool-audit.jsonl")),
    },
  );
  const conversationRepository = new ConversationRepository({ dataDirectory, userName: options.userName });
  const resolveWisp = (id: string): string => conversationRepository.getWispStorageId(id);
  const pluginService = new PluginService({
    dataDirectory,
    encryption,
    authorizationBroker: toolAuthorizationBroker,
    resolveWisp,
  });
  await pluginService.load();
  const mcpService = new McpService({
    dataDirectory,
    encryption,
    authorizationBroker: toolAuthorizationBroker,
    resolveWisp,
    resolveWorkspaceDirectory: (id) => conversationRepository.getWorkspaceDirectory(id),
    openExternal: options.openExternal,
    clientVersion: options.appVersion,
    onSettingsChanged: options.onMcpSettingsChanged,
  });
  await mcpService.load();
  const containerRuntime = new ContainerRuntimeDetector(
    options.containerPrograms ?? (options.agentMode === "fake" ? [] : undefined),
  );
  const containerManager = new ContainerManager({ cli: () => containerRuntime.cli(), dataDirectory });
  const executionService = new ExecutionService({
    dataDirectory,
    encryption,
    resolveWisp: (id) => {
      const { workspaceDirectory, configDirectory } = conversationRepository.getAgentContext(id);
      return { storageId: conversationRepository.getWispStorageId(id), workspaceDirectory, configDirectory };
    },
    listWispStorageIds: () => conversationRepository.listWispStorageIds(),
    authorizationBroker: toolAuthorizationBroker,
    manager: containerManager,
    runtime: containerRuntime,
  });
  const agentFactory: ConversationAgentFactory =
    options.agentMode === "fake"
      ? new FakeConversationAgentFactory({ latencyMs: 350 })
      : new PiConversationAgentFactory(
          new SdkPiSessionFactory(
            modelService.getModelRuntime(),
            toolAuthorizationBroker,
            new CompositeIntegrationToolSource([pluginService, mcpService, executionService]),
            () => modelService.getAuxiliaryModel("imageUnderstanding"),
          ),
        );
  const registry = new AgentRegistry(
    agentFactory,
    publishAgentEvent,
    (conversationId) => toolAuthorizationBroker.cancelConversation(conversationId),
    {
      validateModel: (selection) => modelService.validateConversationSelection(selection),
      onAvailable: (conversationId) => messageQueue?.pump(conversationId),
      isWorkspaceLocked: (conversationId) => storageService?.isCleaning(conversationId) ?? false,
    },
  );
  agentRegistry = registry;
  const service = new ConversationService(
    conversationRepository,
    registry,
    () => toolAuthorizationBroker.listPending(),
    {
      logger,
      onConversationChanged: options.onConversationChanged,
      onConversationsRemoved: () => {
        messageScheduler?.refresh();
        messageQueue?.refresh();
        // A deleted Wisp's container goes with it.
        void executionService.reconcile().catch(() => undefined);
      },
    },
  );
  conversationService = service;
  await service.start(await modelService.getSelection());
  // Containers of Wisps deleted while the server was down; never blocks startup.
  void executionService.reconcile().catch(() => undefined);
  const queue = new MessageQueue({
    repository: conversationRepository,
    isAvailable: (conversationId) => registry.isAvailable(conversationId),
    deliverNext: (conversationId, onTaken) => service.deliverNextQueued(conversationId, onTaken),
    onChanged: options.onMessageQueueChanged,
    logger,
  });
  messageQueue = queue;
  await queue.start();
  const scheduler = new MessageScheduler({
    repository: conversationRepository,
    send: async (conversationId, text, scheduled) => {
      await queue.enqueue(conversationId, text, { scheduled });
    },
    onChanged: options.onScheduledMessagesChanged,
    logger,
  });
  messageScheduler = scheduler;
  scheduler.start();

  const sessionReportService = new SessionReportService(
    conversationRepository,
    new ModelPricingService({ cacheFilePath: path.join(dataDirectory, "model-pricing.json") }),
  );
  const storage = new StorageService({
    listWorkspaces: () => conversationRepository.listWorkspaceFolders(),
    resolveWorkspace: (id) => conversationRepository.getWorkspaceDirectory(id),
    archiveDirectory: conversationRepository.getArchiveDirectory(),
    isBusy: (id) => registry.isBusy(id),
    // Messages queued during the cleanup are delivered once it ends.
    onCleanupFinished: (id) => queue.pump(id),
    resolveQuota: (id, fallback) =>
      readWorkspaceQuota(conversationRepository.getAgentContext(id).configDirectory, fallback),
  });
  storageService = storage;
  const workspaceService = new WorkspaceService({
    acquireWrite: (id) => storage.acquireWrite(id),
    resolveDirectories: (id) => conversationRepository.getAgentContext(id),
    resolveWorkspace: (id) => conversationRepository.getWorkspaceDirectory(id),
    openPath: options.openPath,
    selectFiles: options.selectFiles,
  });
  const transcriptionService = new TranscriptionService({
    credentials: modelService,
    logger,
    ...(options.agentMode === "fake" ? { fetch: fakeTranscriptionFetch() } : {}),
  });
  // Startup used the cached catalog; network updates land after the host is ready.
  if (options.allowModelNetwork ?? true) {
    void refreshModelCatalog(modelService, (selection) => service.applyModel(selection), logger);
  }

  return {
    models: modelService,
    toolAuthorization: toolAuthorizationBroker,
    plugins: pluginService,
    mcp: mcpService,
    registry,
    conversations: service,
    scheduledMessages: scheduler,
    messageQueue: queue,
    sessionReports: sessionReportService,
    workspace: workspaceService,
    storage,
    transcription: transcriptionService,
    execution: executionService,
    applyConversationModel: async (conversationId, model) => {
      if (model) await modelService.validateConversationSelection(model);
      await service.applyConversationModel(conversationId, model);
    },
    reapplySavedModel: async () => service.applyModel(await modelService.getSelection()),
    dispose: async () => {
      // Stop new work and integrations first, then the agents, which may still be settling their last turn.
      await scheduler.dispose();
      queue.dispose();
      modelService.dispose();
      transcriptionService.dispose();
      pluginService.dispose();
      mcpService.dispose();
      toolAuthorizationBroker.dispose();
      await registry.disposeAll();
      // After the agents, so no command starts a container once they are stopped.
      await containerManager.dispose().catch(() => undefined);
      // Last: agents may persist their final messages while they settle.
      await conversationRepository.close();
    },
  };
}

/**
 * Refreshes model catalogs over the network. If the saved model's usability
 * changed (for example, a model only the fresh catalog knows), Wisps are
 * re-applied so they pick it up without a restart. Never throws.
 */
export async function refreshModelCatalog(
  models: Pick<ModelService, "getSelection" | "refreshCatalog">,
  applyModel: (selection: ModelSelection | null) => Promise<void>,
  logger: Pick<StructuredLogger, "warn">,
): Promise<void> {
  try {
    const before = await models.getSelection();
    await models.refreshCatalog();
    const after = await models.getSelection();
    if (!sameSelection(before, after)) await applyModel(after);
  } catch (error) {
    logger.warn("model_catalog_refresh_failed", { code: sanitizeBackendError(error).code });
  }
}

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return (
    left?.providerId === right?.providerId &&
    left?.modelId === right?.modelId &&
    left?.maxOutputTokens === right?.maxOutputTokens
  );
}

/**
 * Waits for a disposal to finish, but never longer than `timeoutMs`: a provider
 * call that ignores its abort signal must not leave the host unable to quit.
 * Resolves true when the disposal completed in time.
 */
export async function disposeWithin(dispose: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = dispose().then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([completed, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
