import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AbortConversationView,
  ModelSelection,
  SequencedConversationAgentEvent,
  WispFallback,
} from "../shared/contracts.js";
import type { ConversationDelta, Wisp, WispsView } from "../shared/conversations.js";
import type { JobsView } from "../shared/jobs.js";
import type { McpSettingsView } from "../shared/mcp.js";
import type { PluginSettingsView } from "../shared/plugins.js";
import { providerKind } from "../shared/provider-kinds.js";
import type { MessageQueueView } from "../shared/message-queue.js";
import type { ScheduledMessagesView } from "../shared/scheduled-messages.js";
import type { AgentMode } from "./agent-mode.js";
import { AgentRegistry } from "./agent-registry.js";
import { CircleAgentFactory } from "./circle-conversation-agent.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationAgentFactory } from "./conversation-agent.js";
import { normalizeWisp, normalizeWispChanges } from "./conversation-normalizer.js";
import { ConversationRepository } from "./conversation-repository.js";
import { ConversationService } from "./conversation-service.js";
import type { EncryptionService } from "./encrypted-credential-store.js";
import { FakeConversationAgentFactory } from "./fake-conversation-agent.js";
import { CompositeIntegrationToolSource } from "./integration-tool-source.js";
import { jobCardItems, jobResultContext } from "./job-host.js";
import { JobRunner } from "./job-runner.js";
import { JobScheduler, type JobRunOutcome } from "./job-scheduler.js";
import type { JobToolHost } from "./job-tools.js";
import { McpService } from "./mcp-service.js";
import type { McpSignInBrowser } from "./mcp-oauth.js";
import { MessageQueue } from "./message-queue.js";
import { MessageScheduler } from "./message-scheduler.js";
import { catalogModelPricing, ModelPricingService } from "./model-pricing-service.js";
import { ModelHolds } from "./model-holds.js";
import { ModelService } from "./model-service.js";
import { SdkPiSessionFactory } from "./pi-session-factory.js";
import { WispConversationAgentFactory } from "./wisp-conversation-agent.js";
import { WispSessionBuilder } from "./wisp-session-plan.js";
import { ClaudeCodeSessionFactory } from "./claude-code/claude-code-session-factory.js";
import { CLAUDE_CODE_FALLBACK_DIRECTORY } from "./claude-code/claude-code-usage-log.js";
import { ClaudeCodeProcesses } from "./claude-code/claude-code-processes.js";
import { ClaudeCodeStatusService } from "./claude-code/claude-code-status.js";
import { RoutingSessionFactory } from "./claude-code/routing-session-factory.js";
import { formatHistorySearch, recentTranscript } from "./claude-code/conversation-history.js";
import { PluginService } from "./plugin-service.js";
import { SessionReportService } from "./session-report-service.js";
import type { StructuredLogger } from "./structured-logger.js";
import { WispToolPolicyStore } from "./wisp-tool-policy-store.js";
import type { WispToolHost } from "./wisp-tools.js";
import { ToolAuditStore } from "./tool-audit-store.js";
import { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { fakeTranscriptionFetch, TranscriptionService } from "./transcription-service.js";
import { StorageService } from "./storage-service.js";
import { readWorkspaceQuota, WorkspaceService } from "./workspace-service.js";
import { ContainerRuntimeDetector, type ContainerCli } from "./container-cli.js";
import { ContainerManager } from "./container-manager.js";
import { BrowserService } from "./browser-service.js";
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
  /** Where the browser of an MCP sign-in runs for the device that asked; defaults to this computer. */
  signInBrowser?: () => Promise<McpSignInBrowser>;
  /** Opens a backend-owned local folder in the system file manager. */
  openPath: (directory: string) => Promise<void>;
  /** Shows a native multi-file picker; resolves with absolute paths, empty when dismissed. */
  selectFiles: () => Promise<ReadonlyArray<string>>;
  /** Receives every agent event after the conversation service has persisted it. */
  onAgentEvent: (event: SequencedConversationAgentEvent) => void;
  /** Receives what changed after agent-driven changes are persisted. */
  onConversationChanged: (delta: ConversationDelta) => void;
  /** Receives the Wisps and conversation summaries after a Wisp was created, changed or deleted. */
  onWispsChanged?: (view: WispsView) => void;
  /** Receives the sanitized MCP view after health or settings changes; secrets never leave the backend. */
  onMcpSettingsChanged: (view: McpSettingsView) => void;
  /** Receives plugin settings after changes another window should see, such as a sign-in. */
  onPluginSettingsChanged?: (view: PluginSettingsView) => void;
  /** Receives every scheduled message after any change, including sends. */
  onScheduledMessagesChanged: (view: ScheduledMessagesView) => void;
  /** Receives every queued message after any change, including a Wisp taking one. */
  onMessageQueueChanged: (view: MessageQueueView) => void;
  /** Receives every job after any change, including runs. */
  onJobsChanged: (view: JobsView) => void;
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
  jobs: JobScheduler;
  sessionReports: SessionReportService;
  workspace: WorkspaceService;
  storage: StorageService;
  transcription: TranscriptionService;
  execution: ExecutionService;
  /** Validates and saves a single Wisp's model override; null clears it. */
  applyConversationModel(conversationId: string, model: ModelSelection | null): Promise<void>;
  /** Validates and saves a single Wisp's fallback choice. */
  applyConversationFallback(conversationId: string, fallback: WispFallback): Promise<void>;
  /** Stops a Wisp's turn and gives back the follow-ups it never read, out of the queue. */
  abortConversation(conversationId: string): Promise<AbortConversationView>;
  /** Re-applies the saved global model, e.g. after a credential change made it usable. */
  reapplySavedModel(): Promise<void>;
  /** Rejects pending approvals, stops integrations, and disposes every agent before closing storage. */
  dispose(): Promise<void>;
}

export async function createBackendRuntime(options: BackendRuntimeOptions): Promise<BackendRuntime> {
  const { dataDirectory, encryption, logger } = options;
  // Whether this server's `claude` can run Claude Code Wisps (ADR 026); the fake agent mode never runs it.
  const claudeCodeStatus = new ClaudeCodeStatusService(
    options.agentMode === "fake" ? { find: async () => undefined } : {},
  );
  const modelService = await ModelService.create({
    dataDirectory,
    encryption,
    ...(options.allowModelNetwork === undefined ? {} : { allowModelNetwork: options.allowModelNetwork }),
    openExternal: options.openExternal,
    ...(options.signInBrowser ? { signInBrowser: options.signInBrowser } : {}),
    claudeCode: claudeCodeStatus,
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
  let jobScheduler: JobScheduler | undefined;
  const requireJobs = (): JobScheduler => {
    if (!jobScheduler) throw new Error("Jobs are not ready.");
    return jobScheduler;
  };
  // The job tools reach the scheduler, which is created once the conversations are.
  const jobHost: JobToolHost = {
    list: async (conversationId) =>
      (await requireJobs().getView()).jobs.filter((job) => job.conversationId === conversationId),
    create: (job) => requireJobs().create(job),
    update: (jobId, changes) => requireJobs().update(jobId, changes),
    delete: (jobId) => requireJobs().delete(jobId),
    recordChange: (job, change) =>
      service.addJobCard(job.conversationId, jobCardItems(job, change), `job-card-${randomUUID()}`),
  };
  // The Wisp tools reach the conversation service, which is created after the session factory.
  const requireConversations = (): ConversationService => {
    if (!conversationService) throw new Error("Conversations are not ready.");
    return conversationService;
  };
  const storedWisp = (wispId: string): Wisp => {
    const wisp = requireConversations().readWisps()[wispId];
    if (!wisp) throw new WispBackendError("not_found", "The Wisp was not found.");
    return wisp;
  };
  const wispHost: WispToolHost = {
    list: () => Object.values(requireConversations().readWisps()),
    create: async (wisp) => {
      // A Wisp's own conversation shares its ID; normalizing checks it as the IPC handler does.
      const created = normalizeWisp({ ...wisp, id: randomUUID() });
      await requireConversations().createWisp(created, { notifyOnUpdatesEnabled: true, model: null });
      return storedWisp(created.id);
    },
    update: async (wispId, changes) => {
      await requireConversations().updateWisp(wispId, normalizeWispChanges(changes));
      return storedWisp(wispId);
    },
    delete: async (wispId) => {
      await requireConversations().deleteWisp(wispId);
    },
  };
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
      wispPolicies: new WispToolPolicyStore((wispId) => conversationRepository.getAgentContext(wispId).configDirectory),
    },
  );
  const conversationRepository = new ConversationRepository({ dataDirectory, userName: options.userName });
  const resolveWisp = (id: string): string => conversationRepository.getWispStorageId(id);
  const pluginService = new PluginService({
    dataDirectory,
    encryption,
    authorizationBroker: toolAuthorizationBroker,
    resolveWisp,
    openExternal: options.openExternal,
    ...(options.signInBrowser ? { signInBrowser: options.signInBrowser } : {}),
    ...(options.onPluginSettingsChanged ? { onSettingsChanged: options.onPluginSettingsChanged } : {}),
  });
  await pluginService.load();
  const mcpService = new McpService({
    dataDirectory,
    encryption,
    authorizationBroker: toolAuthorizationBroker,
    resolveWisp,
    resolveWorkspaceDirectory: (id) => conversationRepository.getWorkspaceDirectory(id),
    openExternal: options.openExternal,
    ...(options.signInBrowser ? { signInBrowser: options.signInBrowser } : {}),
    clientVersion: options.appVersion,
    onSettingsChanged: options.onMcpSettingsChanged,
    logger,
  });
  await mcpService.load();
  const containerRuntime = new ContainerRuntimeDetector(
    options.containerPrograms ?? (options.agentMode === "fake" ? [] : undefined),
  );
  const containerManager = new ContainerManager({ cli: () => containerRuntime.cli(), dataDirectory });
  const resolveExecutionWisp = (id: string) => {
    const { workspaceDirectory, configDirectory } = conversationRepository.getAgentContext(id);
    return { storageId: conversationRepository.getWispStorageId(id), workspaceDirectory, configDirectory };
  };
  const browserService = new BrowserService({
    resolveWisp: resolveExecutionWisp,
    authorizationBroker: toolAuthorizationBroker,
    manager: containerManager,
    runtime: containerRuntime,
  });
  const executionService = new ExecutionService({
    dataDirectory,
    resolveWisp: resolveExecutionWisp,
    listWispStorageIds: () => conversationRepository.listWispStorageIds(),
    authorizationBroker: toolAuthorizationBroker,
    manager: containerManager,
    runtime: containerRuntime,
    gitForges: (id) => mcpService.gitForges(id),
    browser: browserService,
  });
  const toolSource = new CompositeIntegrationToolSource([pluginService, mcpService, executionService, browserService]);
  // Read when a model fails, so a changed choice applies without rebuilding the session.
  const fallbackModels = async (wispId: string) => {
    const { modelOverride, fallback } = conversationRepository.getAgentContext(wispId);
    return modelService.getFallbackModels(modelOverride ?? null, fallback ?? null);
  };
  // Rate limits and outages hold a model for every Wisp of this backend, whichever runtime hit them.
  const modelHolds = new ModelHolds();
  const piSessionFactory = new SdkPiSessionFactory(
    modelService.getModelRuntime(),
    toolAuthorizationBroker,
    toolSource,
    () => modelService.getAuxiliaryModel("imageUnderstanding"),
    jobHost,
    fallbackModels,
    wispHost,
    modelHolds,
  );
  const claudeCodeSessionFactory = new ClaudeCodeSessionFactory({
    builder: new WispSessionBuilder({
      authorizationBroker: toolAuthorizationBroker,
      toolSource,
      jobs: jobHost,
      wisps: wispHost,
    }),
    status: claudeCodeStatus,
    recentTranscript: async ({ conversationId, wispId }) =>
      recentTranscript(await conversationRepository.getMessagePage({ conversationId, page: "latest" }), {
        wispId,
        names: new Map(Object.values(conversationRepository.readWisps()).map(({ id, name }) => [id, name])),
      }),
    searchHistory: async (conversationId, query) =>
      formatHistorySearch(conversationId, await conversationRepository.searchMessages(query)),
    webSearch: (wispId) => pluginService.searchesWithClaude(wispId),
    // A Pi session of its own, so the conversation's Pi session and identity stay as they are.
    fallback: async (context) => {
      // The first fallback answers; its own session moves on to the others if it fails too.
      const [choice] = await fallbackModels(context.wispId);
      if (!choice) return null;
      const model = piSessionFactory.resolveModel(choice);
      // Each fallback turn starts fresh in a folder of its own, which the session report reads.
      const sessionDirectory = path.join(
        context.sessionDirectory,
        CLAUDE_CODE_FALLBACK_DIRECTORY,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
      );
      const session = await piSessionFactory.create(
        {
          ...context,
          sessionDirectory,
          piSessionId: null,
          piSessionFile: null,
          savePiSessionIdentity: undefined,
          onContextRenewed: undefined,
        },
        choice,
      );
      return { name: model.name || model.id, session };
    },
    processes: new ClaudeCodeProcesses(),
    holds: modelHolds,
  });
  const sessionFactory = new RoutingSessionFactory(piSessionFactory, claudeCodeSessionFactory);
  const agentFactory: ConversationAgentFactory =
    options.agentMode === "fake"
      ? new FakeConversationAgentFactory({ latencyMs: 350, steering: true })
      : new WispConversationAgentFactory(sessionFactory);
  const registry = new AgentRegistry(
    new CircleAgentFactory(agentFactory, {
      // Through the service, so a member reads the replies before its own even before they are stored.
      readTranscript: (conversationId) => {
        if (!conversationService) throw new Error("The conversation service has not started.");
        return conversationService.getMessagePage({ conversationId, page: "latest" });
      },
    }),
    publishAgentEvent,
    (conversationId) => toolAuthorizationBroker.cancelConversation(conversationId),
    {
      validateModel: (selection) => modelService.validateConversationSelection(selection),
      onAvailable: (conversationId) => messageQueue?.pump(conversationId),
      onTurnStarted: (conversationId) => void messageQueue?.offerFollowUps(conversationId),
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
      ...(options.onWispsChanged ? { onWispsChanged: options.onWispsChanged } : {}),
      onConversationsRemoved: () => {
        messageScheduler?.refresh();
        jobScheduler?.refresh();
        messageQueue?.refresh();
        // A deleted Wisp's container goes with it.
        void executionService.reconcile().catch(() => undefined);
      },
      onFollowUpTaken: (_conversationId, queuedMessageId) => messageQueue?.followUpTaken(queuedMessageId),
      // Claude Code keeps the transcripts of a Wisp that ran on it outside Wisp's data: a
      // deleted workspace's go with its project, a circle member's one session at a time.
      onSessionsEnding: async ({ workspaces, sessions }) => {
        const projects = (
          await Promise.all(
            workspaces.map(async ({ workspaceDirectory, sessionDirectories }) =>
              (
                await Promise.all(
                  sessionDirectories.map((directory) => claudeCodeSessionFactory.usedClaudeCode(directory)),
                )
              ).some(Boolean)
                ? [workspaceDirectory]
                : [],
            ),
          )
        ).flat();
        const ended = (
          await Promise.all(
            sessions.map(async ({ workspaceDirectory, sessionDirectory }) => ({
              workspaceDirectory,
              sessionIds: await claudeCodeSessionFactory.sessionIds(sessionDirectory),
            })),
          )
        ).filter(({ sessionIds }) => sessionIds.length);
        if (!projects.length && !ended.length) return undefined;
        return () => {
          for (const workspaceDirectory of projects) {
            void claudeCodeSessionFactory
              .purge(workspaceDirectory)
              .catch(() => logger.warn("claude_code_purge_failed"));
          }
          for (const { workspaceDirectory, sessionIds } of ended) {
            void claudeCodeSessionFactory
              .deleteSessions(workspaceDirectory, sessionIds)
              .catch(() => logger.warn("claude_code_session_delete_failed"));
          }
        };
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
    steer: (message) =>
      registry.steer({ conversationId: message.conversationId, requestId: message.id, text: message.text }),
    withdrawFollowUps: (conversationId) => registry.withdrawFollowUps(conversationId),
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

  const jobRunner = new JobRunner({
    sessionFactory,
    getContext: (conversationId) => conversationRepository.getAgentContext(conversationId),
    getSelection: async (context) => context.modelOverride ?? (await modelService.getSelection()),
    runUnattended: (grant, run) => toolAuthorizationBroker.runUnattended(grant, run),
  });
  const jobs = new JobScheduler({
    repository: conversationRepository,
    // The fake agent mode never reaches a model, so its runs answer at once.
    runJob: options.agentMode === "fake" ? fakeJobRun : jobRunner.run,
    deliver: (job, text, run) =>
      service.deliverJobMessage(
        job.conversationId,
        text,
        { jobId: job.id, runId: run.id, title: job.title },
        jobResultContext(job, text, new Date()),
      ),
    notify: (job, text) => service.addJobNotice(job.conversationId, text, `job-notice-${randomUUID()}`),
    onChanged: options.onJobsChanged,
    logger,
  });
  jobScheduler = jobs;
  jobs.start();

  const sessionReportService = new SessionReportService(
    conversationRepository,
    new ModelPricingService({ cacheFilePath: path.join(dataDirectory, "model-pricing.json") }),
    (providerId, modelId) => {
      // A custom endpoint's models list no price, which is not the same as costing nothing.
      if (providerKind(providerId).prices === "unknown") return null;
      const model = modelService.getModelRuntime().getModel(providerId, modelId);
      return model ? catalogModelPricing(model.cost) : null;
    },
    (alias) => mcpService.describeTool(alias),
  );
  const storage = new StorageService({
    listWorkspaces: () => conversationRepository.listWorkspaceFolders(),
    resolveWorkspace: (id) => conversationRepository.getWorkspaceDirectory(id),
    archiveDirectory: conversationRepository.getArchiveDirectory(),
    isBusy: (id) => registry.isBusy(id),
    // Messages queued during the cleanup are delivered once it ends.
    onCleanupFinished: (id) => queue.pump(id),
    resolveQuota: (id, fallback) =>
      readWorkspaceQuota(conversationRepository.getWorkspaceDirectories(id).settingsDirectory, fallback),
  });
  storageService = storage;
  const workspaceService = new WorkspaceService({
    acquireWrite: (id) => storage.acquireWrite(id),
    resolveDirectories: (id) => conversationRepository.getAgentContext(id),
    resolveWorkspace: (id) => conversationRepository.getWorkspaceDirectories(id),
    openPath: options.openPath,
    selectFiles: options.selectFiles,
    // The summary shows each workspace's size, so a resize must not wait for the cache to expire.
    onQuotaChanged: () => storage.invalidate(),
    workspaceRoot: path.join(dataDirectory, "workspaces"),
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
    jobs,
    sessionReports: sessionReportService,
    workspace: workspaceService,
    storage,
    transcription: transcriptionService,
    execution: executionService,
    applyConversationModel: async (conversationId, model) => {
      if (model) {
        await modelService.validateConversationSelection(model);
        modelService.assertSupportedThinkingLevel(model);
      }
      await service.applyConversationModel(conversationId, model);
    },
    applyConversationFallback: async (conversationId, fallback) => {
      if (typeof fallback === "object") await modelService.assertUsableFallback(fallback);
      await service.applyConversationFallback(conversationId, fallback);
    },
    abortConversation: async (conversationId) => ({
      followUps: await queue.returnFollowUps(await registry.abort(conversationId)),
    }),
    reapplySavedModel: async () => service.applyModel(await modelService.getSelection()),
    dispose: async () => {
      // Stop new work and integrations first, then the agents, which may still be settling their last turn.
      await jobs.dispose();
      await scheduler.dispose();
      queue.dispose();
      modelService.dispose();
      transcriptionService.dispose();
      pluginService.dispose();
      mcpService.dispose();
      toolAuthorizationBroker.dispose();
      await registry.disposeAll();
      // After the agents, so no command starts a container once they are stopped.
      await browserService.dispose().catch(() => undefined);
      await containerManager.dispose().catch(() => undefined);
      // Last: agents may persist their final messages while they settle.
      await conversationRepository.close();
    },
  };
}

async function fakeJobRun(job: { title: string }): Promise<JobRunOutcome> {
  return { kind: "message", text: `## ${job.title}\n\nThis is a test result from the fake agent.` };
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
    left?.maxOutputTokens === right?.maxOutputTokens &&
    left?.thinkingLevel === right?.thinkingLevel
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
