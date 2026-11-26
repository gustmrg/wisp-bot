import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AbortConversationView,
  ConversationModelView,
  ModelSelection,
  SequencedConversationAgentEvent,
  WispFallback,
} from "../shared/contracts.js";
import {
  circleLeadId,
  type CircleChat,
  type CircleSummary,
  type ConversationDelta,
  type Wisp,
  type WispsView,
} from "../shared/conversations.js";
import { CLAUDE_CODE_PROVIDER } from "../shared/claude-code.js";
import { isJobFinished, type JobsView } from "../shared/jobs.js";
import type { McpSettingsView } from "../shared/mcp.js";
import { pluginCatalogEntry, type PluginSettingsView } from "../shared/plugins.js";
import type { MessageQueueView } from "../shared/message-queue.js";
import { describeSchedule } from "../shared/schedule.js";
import type { ScheduledMessagesView } from "../shared/scheduled-messages.js";
import type { AgentMode } from "./agent-mode.js";
import { AgentRegistry } from "./agent-registry.js";
import { CircleAgentFactory } from "./circle-conversation-agent.js";
import { appendDecisionUsage, CircleRouter } from "./circle-router.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import { isCircleContext, type ConversationAgentFactory } from "./conversation-agent.js";
import { normalizeChat, normalizeChatChanges, normalizeWisp, normalizeWispChanges } from "./conversation-normalizer.js";
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
import { ModelService } from "./model-service.js";
import { SdkPiSessionFactory } from "./pi-session-factory.js";
import { WispConversationAgentFactory } from "./wisp-conversation-agent.js";
import { WispSessionBuilder } from "./wisp-session-plan.js";
import { ClaudeCodeSessionFactory } from "./claude-code/claude-code-session-factory.js";
import { CLAUDE_CODE_FALLBACK_DIRECTORY } from "./claude-code/claude-code-usage-log.js";
import { ClaudeCodeProcesses } from "./claude-code/claude-code-processes.js";
import { ClaudeCodeStatusService } from "./claude-code/claude-code-status.js";
import { ClaudeCodeActivity } from "./claude-code/claude-code-activity.js";
import { ClaudeCodeUpdateService } from "./claude-code/claude-code-update.js";
import { RoutingSessionFactory } from "./claude-code/routing-session-factory.js";
import { formatHistorySearch, recentTranscript } from "./claude-code/conversation-history.js";
import { PluginService } from "./plugin-service.js";
import { RuntimeEventLog } from "./runtime-event-log.js";
import { SessionReportService } from "./session-report-service.js";
import type { StructuredLogger } from "./structured-logger.js";
import { WispToolPolicyStore } from "./wisp-tool-policy-store.js";
import type { WispToolHost } from "./wisp-tools.js";
import { WispConsultationRunner } from "./wisp-consultation.js";
import { SkillStore } from "./skill-store.js";
import { ToolAuditStore } from "./tool-audit-store.js";
import { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { fakeTranscriptionFetch, TranscriptionService } from "./transcription-service.js";
import { StorageService } from "./storage-service.js";
import { readWorkspaceQuota, SKILLS_DIRECTORY, WorkspaceService } from "./workspace-service.js";
import { WispTemplateStore } from "./wisp-template-store.js";
import { ContainerRuntimeDetector, type ContainerCli } from "./container-cli.js";
import { ContainerManager } from "./container-manager.js";
import { BrowserService } from "./browser-service.js";
import { ExecutionService, readCircleCommands, readExecutionSettings } from "./execution-service.js";

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
  /** Raw runtime events of the conversations someone is debugging, kept in the data directory. */
  runtimeEvents: RuntimeEventLog;
  workspace: WorkspaceService;
  storage: StorageService;
  transcription: TranscriptionService;
  execution: ExecutionService;
  /** The built-in Wisp templates and the ones saved in this environment. */
  templates: WispTemplateStore;
  /** A Wisp's model, and why it cannot answer when its model cannot run now. */
  getConversationModel(conversationId: string): Promise<ConversationModelView>;
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

/**
 * Composes the backend and starts it: restores the agents, then the message
 * queue, scheduled messages and jobs, and the background updates.
 */
export async function createBackendRuntime(options: BackendRuntimeOptions): Promise<BackendRuntime> {
  const composed = await composeBackendRuntime(options);
  try {
    await composed.activate();
  } catch (error) {
    await composed.runtime.dispose().catch(() => undefined);
    throw error;
  }
  return composed.runtime;
}

/**
 * Opens an environment's data the way a start does, upgrading its database
 * and loading every store, then closes it without activating anything: no
 * agent runs, no queued or scheduled message is sent, no job starts, no
 * request is marked failed, no container is touched and nothing is fetched.
 * A server update runs it with the new version before committing to it
 * (ADR 046). Fails when the data cannot be opened, including when the
 * database had to be set aside as unreadable, which a start would hide.
 */
export async function prepareBackendData(options: BackendRuntimeOptions): Promise<void> {
  const composed = await composeBackendRuntime({ ...options, allowModelNetwork: false });
  try {
    await composed.prepare();
  } finally {
    await composed.runtime.dispose();
  }
}

/**
 * Builds every service without starting any. `activate` starts them;
 * `prepare` only opens and upgrades the stored data.
 */
async function composeBackendRuntime(options: BackendRuntimeOptions): Promise<{
  runtime: BackendRuntime;
  activate: () => Promise<void>;
  prepare: () => Promise<void>;
}> {
  const { dataDirectory, encryption, logger } = options;
  // Whether this server's `claude` can run Claude Code Wisps (ADR 026); the fake agent mode never runs it.
  const claudeCodeStatus = new ClaudeCodeStatusService(
    options.agentMode === "fake" ? { find: async () => undefined } : {},
  );
  const claudeCodeActivity = new ClaudeCodeActivity();
  const claudeCodeUpdate = new ClaudeCodeUpdateService({ status: claudeCodeStatus, activity: claudeCodeActivity });
  const modelService = await ModelService.create({
    dataDirectory,
    encryption,
    ...(options.allowModelNetwork === undefined ? {} : { allowModelNetwork: options.allowModelNetwork }),
    openExternal: options.openExternal,
    ...(options.signInBrowser ? { signInBrowser: options.signInBrowser } : {}),
    claudeCode: claudeCodeStatus,
    claudeCodeUpdate,
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
  let workspaceServiceRef: WorkspaceService | undefined;
  let pluginServiceRef: PluginService | undefined;
  let mcpServiceRef: McpService | undefined;
  let consultationRunner: WispConsultationRunner | undefined;
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
  const describeWispModel = (selection: ModelSelection) => ({
    ...modelService.describeSelection(selection),
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
  });
  const validateWispModel = async (selection: ModelSelection) => {
    await modelService.validateConversationSelection(selection);
    modelService.assertSupportedThinkingLevel(selection);
    return describeWispModel(selection);
  };
  const validateWispFallback = async (selection: ModelSelection, modelOverride: ModelSelection | null) => {
    await modelService.assertUsableFallback(selection, modelOverride);
    return describeWispModel(selection);
  };
  const circleSummaryOf = async (chat: CircleSummary) => {
    let commandsEnabled = false;
    try {
      const target = conversationRepository.getCircleExecutionTarget(chat.id);
      commandsEnabled = await readCircleCommands(target.settingsDirectory);
    } catch {
      commandsEnabled = false;
    }
    return {
      id: chat.id,
      name: chat.name,
      description: chat.description,
      memberIds: [...chat.memberIds],
      responder: chat.responder ?? ("lead" as const),
      commandsEnabled,
    };
  };
  const wispHost: WispToolHost = {
    list: () => Object.values(requireConversations().readWisps()),
    create: async (wisp, createOptions) => {
      const modelOverride = createOptions?.model ?? null;
      if (modelOverride) await validateWispModel(modelOverride);
      if (createOptions?.fallback && typeof createOptions.fallback === "object") {
        await validateWispFallback(createOptions.fallback, modelOverride);
      }
      // A Wisp's own conversation shares its ID; normalizing checks it as the IPC handler does.
      const created = normalizeWisp({ ...wisp, id: randomUUID() });
      await requireConversations().createWisp(created, { notifyOnUpdatesEnabled: true, model: modelOverride });
      if (createOptions?.fallback !== undefined) {
        await requireConversations().applyConversationFallback(created.id, createOptions.fallback);
      }
      return storedWisp(created.id);
    },
    update: async (wispId, changes, updateOptions) => {
      const currentContext = conversationRepository.getAgentContext(wispId);
      const nextModelOverride =
        updateOptions?.model !== undefined ? updateOptions.model : (currentContext.modelOverride ?? null);
      if (updateOptions?.model) await validateWispModel(updateOptions.model);
      if (updateOptions?.fallback && typeof updateOptions.fallback === "object") {
        await validateWispFallback(updateOptions.fallback, nextModelOverride);
      }
      if (Object.keys(changes).length > 0) {
        await requireConversations().updateWisp(wispId, normalizeWispChanges(changes));
      }
      if (updateOptions?.model !== undefined) {
        await requireConversations().applyConversationModel(wispId, updateOptions.model);
      }
      if (updateOptions?.fallback !== undefined) {
        await requireConversations().applyConversationFallback(wispId, updateOptions.fallback);
      }
      return storedWisp(wispId);
    },
    delete: async (wispId) => {
      await requireConversations().deleteWisp(wispId);
    },
    settings: async (wispId, settingsOptions) => {
      const context = conversationRepository.getAgentContext(wispId);
      const modelOverride = context.modelOverride ?? null;
      const selection = modelOverride ?? (await modelService.getSelection());
      const fallback = await modelService.getFallbackModel(modelOverride, context.fallback ?? null);
      const circles = Object.values(conversationRepository.readChats())
        .filter((chat): chat is CircleSummary => chat.kind === "circle" && chat.memberIds.includes(wispId))
        .map((circle) => ({
          id: circle.id,
          name: circle.name,
          isLead: circleLeadId(circle) === wispId,
        }));
      const exec = await readExecutionSettings(context.configDirectory).catch(() => ({
        mode: "off" as const,
        image: null,
        localNetwork: false,
        browser: false,
      }));
      const base = {
        model: selection ? describeWispModel(selection) : null,
        modelSource: (modelOverride ? "wisp" : "app") as "wisp" | "app",
        modelOverride,
        fallback: fallback ? describeWispModel(fallback) : null,
        circles,
        capabilities: {
          commands: exec.mode === "container",
          localNetwork: exec.localNetwork,
          browser: exec.browser,
        },
      };
      if (!settingsOptions?.detail) return base;
      const [skills, allJobs, workspaceView] = await Promise.all([
        new SkillStore(path.join(context.configDirectory, SKILLS_DIRECTORY)).summaries().catch(() => []),
        jobScheduler
          ? jobScheduler
              .getView()
              .then((view) => view.jobs)
              .catch(() => [])
          : Promise.resolve([]),
        workspaceServiceRef ? workspaceServiceRef.getView(wispId).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      const jobs = allJobs
        .filter((job) => job.conversationId === wispId && !isJobFinished(job))
        .map((job) => ({
          title: job.title,
          schedule: describeSchedule(job.schedule, job.timeZone),
          paused: Boolean(job.paused),
        }));
      // Non-secret names and access levels only: never read credentials, endpoints, headers, or auth config.
      const plugins = pluginServiceRef
        ? pluginServiceRef
            .getAccess({ conversationId: wispId })
            .grants.filter((grant) => grant.access !== "none")
            .map((grant) => ({
              name: pluginCatalogEntry(grant.pluginId).name,
              access: grant.access === "write" && grant.alwaysAllowAll ? "write (without asking)" : grant.access,
            }))
        : [];
      const mcpNames = mcpServiceRef?.getServerNames();
      const mcpServers = mcpServiceRef
        ? mcpServiceRef
            .getAccess({ conversationId: wispId })
            .grants.filter((grant) => grant.access !== "none")
            .map((grant) => ({
              name: mcpNames?.get(grant.serverId) ?? grant.serverId,
              access: grant.access === "allow_all" ? "use_without_asking" : grant.access,
            }))
        : [];
      return {
        ...base,
        skills: skills.map(({ name, description }) => ({ name, description })),
        jobs,
        capabilities: {
          ...base.capabilities,
          ...(workspaceView
            ? {
                workspaceUsedBytes: workspaceView.usedBytes,
                workspaceQuotaBytes: workspaceView.quotaBytes,
                workspaceUnlimited: workspaceView.unlimited,
              }
            : {}),
        },
        integrations: { plugins, mcpServers },
      };
    },
    listModels: async () =>
      (await modelService.listUsableProviders()).map((provider) => ({
        id: provider.id,
        name: provider.name,
        fallback: provider.id !== CLAUDE_CODE_PROVIDER,
        models: provider.models.map(({ id, name, thinkingLevels }) => ({ id, name, thinkingLevels })),
      })),
    validateModel: validateWispModel,
    validateFallback: validateWispFallback,
    listCircles: async () => {
      const circles = Object.values(conversationRepository.readChats()).filter(
        (chat): chat is CircleSummary => chat.kind === "circle",
      );
      return Promise.all(circles.map(circleSummaryOf));
    },
    createCircle: async ({ name, description, memberIds, responder }) => {
      const circle = normalizeChat({
        id: randomUUID(),
        kind: "circle",
        name,
        label: "",
        description,
        memberIds,
        notifyOnUpdatesEnabled: true,
        preview: "Ready for the first task.",
        messages: [],
        ...(responder === "auto" ? { responder: "auto" } : {}),
      }) as CircleChat;
      await requireConversations().create(circle);
      const stored = conversationRepository.readChat(circle.id);
      if (!stored || stored.kind !== "circle") {
        throw new WispBackendError("internal_error", "The circle could not be read after creation.");
      }
      return circleSummaryOf(stored);
    },
    updateCircle: async (circleId, changes) => {
      const normalized = normalizeChatChanges({ kind: "circle", ...changes });
      await requireConversations().update(circleId, normalized);
      const stored = conversationRepository.readChat(circleId);
      if (!stored || stored.kind !== "circle") {
        throw new WispBackendError("not_found", "The circle was not found.");
      }
      return circleSummaryOf(stored);
    },
    ask: async (request, signal) => {
      if (options.agentMode === "fake") {
        if (request.targetWispId === request.callerWispId) {
          throw new WispBackendError("invalid_request", "A Wisp cannot consult itself.");
        }
        if (signal?.aborted) throw new WispBackendError("aborted", "The consultation was cancelled.");
        const target = storedWisp(request.targetWispId);
        return `Fake reply from ${target.name}: ${request.message}`;
      }
      if (!consultationRunner) {
        throw new WispBackendError("unavailable", "Consulting another Wisp is not ready.");
      }
      return consultationRunner.consult(request, signal);
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
  pluginServiceRef = pluginService;
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
  mcpServiceRef = mcpService;
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
    resolveCircle: (id) => conversationRepository.getCircleExecutionTarget(id),
    listCircles: () => conversationRepository.listCircleExecutionTargets(),
    authorizationBroker: toolAuthorizationBroker,
    manager: containerManager,
    runtime: containerRuntime,
    gitForges: (id) => mcpService.gitForges(id),
    browser: browserService,
  });
  const toolSource = new CompositeIntegrationToolSource([pluginService, mcpService, executionService, browserService]);
  // Read when a model fails, so a changed choice applies without rebuilding the session.
  const fallbackModel = async (wispId: string) => {
    const { modelOverride, fallback } = conversationRepository.getAgentContext(wispId);
    return modelService.getFallbackModel(modelOverride ?? null, fallback ?? null);
  };
  const piSessionFactory = new SdkPiSessionFactory(
    modelService.getModelRuntime(),
    toolAuthorizationBroker,
    toolSource,
    () => modelService.getAuxiliaryModel("imageUnderstanding"),
    jobHost,
    fallbackModel,
    wispHost,
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
      const choice = await fallbackModel(context.wispId);
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
    activity: claudeCodeActivity,
  });
  const sessionFactory = new RoutingSessionFactory(piSessionFactory, claudeCodeSessionFactory);
  consultationRunner = new WispConsultationRunner({
    sessionFactory,
    getContext: (wispId) => conversationRepository.getAgentContext(wispId),
    getSelection: async (context) => context.modelOverride ?? (await modelService.getSelection()),
    routeApprovals: (conversationId, run) => toolAuthorizationBroker.routeApprovals(conversationId, run),
  });
  const runtimeEvents = new RuntimeEventLog({
    directory: path.join(dataDirectory, "runtime-events"),
    // Only this environment's credentials: each environment keeps its own (see docs/security.md).
    secretValues: async () =>
      (
        await Promise.all([modelService.secretValues(), pluginService.secretValues(), mcpService.secretValues()])
      ).flat(),
  });
  await runtimeEvents.load();
  const agentFactory: ConversationAgentFactory =
    options.agentMode === "fake"
      ? new FakeConversationAgentFactory({ latencyMs: 350, steering: true, runtimeEvents })
      : new WispConversationAgentFactory(sessionFactory, { runtimeEvents });
  const circleRouter = new CircleRouter({
    getSelection: () => modelService.getAuxiliaryModel("decision"),
    runtime: modelService.getModelRuntime(),
    recordUsage: (conversationId, entry) =>
      appendDecisionUsage(conversationRepository.circleDecisionUsageDirectory(conversationId), entry),
    onFailed: (conversationId) => logger.warn("circle_routing_failed", { conversationId }),
  });
  const registry = new AgentRegistry(
    new CircleAgentFactory(agentFactory, {
      // Through the service, so a member reads the replies before its own even before they are stored.
      readTranscript: (conversationId) => {
        if (!conversationService) throw new Error("The conversation service has not started.");
        return conversationService.getMessagePage({ conversationId, page: "latest" });
      },
      chooseResponder: (input, signal) => circleRouter.choose(input, signal),
    }),
    publishAgentEvent,
    (conversationId) => toolAuthorizationBroker.cancelConversation(conversationId),
    {
      validateModel: (selection) => modelService.validateConversationSelection(selection),
      onAvailable: (conversationId) => messageQueue?.pump(conversationId),
      onTurnStarted: (conversationId) => {
        // What a turn does to the workspace is measured again the next time Storage is opened.
        storageService?.markChanged(conversationId);
        void messageQueue?.offerFollowUps(conversationId);
      },
      onTurnEnded: (conversationId) => storageService?.markChanged(conversationId),
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
        // And so do the runtime events it recorded.
        void runtimeEvents.reconcile(new Set(Object.keys(conversationRepository.readChats()))).catch(() => undefined);
      },
      // A member that left a circle takes its container there with it.
      onCircleMembersLeft: () => void executionService.reconcile().catch(() => undefined),
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
  const queue = new MessageQueue({
    repository: conversationRepository,
    isAvailable: (conversationId) => registry.isAvailable(conversationId),
    takesSideBySide: (conversationId) => registry.takesSideBySide(conversationId),
    deliverNext: (conversationId, onTaken) => service.deliverNextQueued(conversationId, onTaken),
    steer: (message) =>
      registry.steer({ conversationId: message.conversationId, requestId: message.id, text: message.text }),
    withdrawFollowUps: (conversationId) => registry.withdrawFollowUps(conversationId),
    onChanged: options.onMessageQueueChanged,
    logger,
  });
  messageQueue = queue;
  const scheduler = new MessageScheduler({
    repository: conversationRepository,
    send: async (conversationId, text, scheduled) => {
      await queue.enqueue(conversationId, text, { scheduled });
    },
    onChanged: options.onScheduledMessagesChanged,
    logger,
  });
  messageScheduler = scheduler;

  const jobRunner = new JobRunner({
    sessionFactory,
    getContext: (conversationId) => conversationRepository.getAgentContext(conversationId),
    getSelection: async (context) => context.modelOverride ?? (await modelService.getSelection()),
    runUnattended: (grant, run) => toolAuthorizationBroker.runUnattended(grant, run),
  });
  const jobs = new JobScheduler({
    repository: conversationRepository,
    // The fake agent mode never reaches a model, so its runs answer at once.
    runJob: async (job, context) => {
      // A job's commands and files change its conversation's workspace, as a turn does.
      storageService?.markChanged(job.conversationId);
      try {
        return await (options.agentMode === "fake" ? fakeJobRun : jobRunner.run)(job, context);
      } finally {
        storageService?.markChanged(job.conversationId);
      }
    },
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

  const sessionReportService = new SessionReportService(
    conversationRepository,
    new ModelPricingService({ cacheFilePath: path.join(dataDirectory, "model-pricing.json") }),
    (providerId, modelId) => {
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
    measurementsFile: path.join(dataDirectory, "storage-measurements.json"),
    measureRuntimeEvents: () => runtimeEvents.measure(),
  });
  storageService = storage;
  const workspaceService = new WorkspaceService({
    acquireWrite: (id) => storage.acquireWrite(id),
    resolveDirectories: (id) => conversationRepository.getAgentContext(id),
    resolveWorkspace: (id) => conversationRepository.getWorkspaceDirectories(id),
    openPath: options.openPath,
    selectFiles: options.selectFiles,
    workspaceRoot: path.join(dataDirectory, "workspaces"),
  });
  workspaceServiceRef = workspaceService;
  const transcriptionService = new TranscriptionService({
    credentials: modelService,
    logger,
    ...(options.agentMode === "fake" ? { fetch: fakeTranscriptionFetch() } : {}),
  });
  // Ready again after `claude update` or a sign-in, or no longer ready: Wisps re-apply their models (ADR 026).
  const stopFollowingClaudeCode = claudeCodeStatus.onChange(() => {
    void modelService
      .getSelection()
      .then((selection) => service.applyModel(selection))
      .catch((error: unknown) => logger.warn("claude_code_reapply_failed", { code: sanitizeBackendError(error).code }));
  });
  let stopCatalogRefresh = (): void => undefined;
  const activate = async (): Promise<void> => {
    await service.start(await modelService.getSelection());
    // Containers of Wisps deleted while the server was down; never blocks startup.
    void executionService.reconcile().catch(() => undefined);
    await queue.start();
    scheduler.start();
    jobs.start();
    // Startup used the cached catalog; network updates land after the host is ready, and keep
    // landing while it runs, so a server that is never restarted still sees new models.
    if (options.allowModelNetwork ?? true) {
      stopCatalogRefresh = scheduleModelCatalogRefresh(() =>
        refreshModelCatalog(modelService, (selection) => service.applyModel(selection), logger),
      );
    }
  };
  const prepare = async (): Promise<void> => {
    await conversationRepository.load();
    if (conversationRepository.didRecoverCorruptState()) {
      throw new Error("The conversation database could not be read and was set aside.");
    }
  };

  const runtime: BackendRuntime = {
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
    runtimeEvents,
    workspace: workspaceService,
    storage,
    transcription: transcriptionService,
    execution: executionService,
    templates: new WispTemplateStore(path.join(dataDirectory, "wisp-templates")),
    getConversationModel: async (conversationId) => {
      const view = service.getConversationModel(conversationId);
      // A circle has no model of its own; each member's is shown in its own chat.
      if (view.status !== "configuration_required") return view;
      if (isCircleContext(conversationRepository.getAgentContext(conversationId))) return view;
      const unavailable = await modelService.unavailableReason(view.override);
      return unavailable
        ? { ...view, unavailable: unavailable.message, unavailableProviderId: unavailable.providerId }
        : view;
    },
    applyConversationModel: async (conversationId, model) => {
      if (model) {
        await modelService.validateConversationSelection(model);
        modelService.assertSupportedThinkingLevel(model);
      }
      await service.applyConversationModel(conversationId, model);
    },
    applyConversationFallback: async (conversationId, fallback) => {
      if (typeof fallback === "object") {
        const { modelOverride } = conversationRepository.getAgentContext(conversationId);
        await modelService.assertUsableFallback(fallback, modelOverride ?? null);
      }
      await service.applyConversationFallback(conversationId, fallback);
    },
    abortConversation: async (conversationId) => ({
      followUps: await queue.returnFollowUps(await registry.abort(conversationId)),
    }),
    reapplySavedModel: async () => service.applyModel(await modelService.getSelection()),
    dispose: async () => {
      // Stop new work and integrations first, then the agents, which may still be settling their last turn.
      stopFollowingClaudeCode();
      stopCatalogRefresh();
      await jobs.dispose();
      await scheduler.dispose();
      queue.dispose();
      modelService.dispose();
      transcriptionService.dispose();
      pluginService.dispose();
      mcpService.dispose();
      toolAuthorizationBroker.dispose();
      await registry.disposeAll();
      // After the agents, whose last turns mark their workspaces changed.
      await storage.flush();
      // After the agents, so no command starts a container once they are stopped.
      await browserService.dispose().catch(() => undefined);
      await containerManager.dispose().catch(() => undefined);
      // Last: agents may persist their final messages while they settle.
      await conversationRepository.close();
    },
  };
  return { runtime, activate, prepare };
}

async function fakeJobRun(job: { title: string }): Promise<JobRunOutcome> {
  return { kind: "message", text: `## ${job.title}\n\nThis is a test result from the fake agent.` };
}

/**
 * How often a running backend checks for catalog updates. Pi fetches only the
 * providers it has not checked in the last four hours, so most checks send
 * nothing, and a new model appears within about five hours.
 */
export const MODEL_CATALOG_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Refreshes the catalog now and then every `intervalMs`; returns a function that stops it. */
export function scheduleModelCatalogRefresh(
  refresh: () => Promise<void>,
  intervalMs = MODEL_CATALOG_CHECK_INTERVAL_MS,
): () => void {
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  // Never keeps a process alive that is otherwise done.
  timer.unref?.();
  return () => clearInterval(timer);
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
