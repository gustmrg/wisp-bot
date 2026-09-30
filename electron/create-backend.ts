import path from "node:path";

import { WISP_IPC_CHANNELS, type ModelSelection, type SequencedConversationAgentEvent } from "../shared/contracts.js";
import type { AgentMode } from "./backend/agent-mode.js";
import { AgentRegistry } from "./backend/agent-registry.js";
import { sanitizeBackendError } from "./backend/backend-error.js";
import type { ConversationAgentFactory } from "./backend/conversation-agent.js";
import { ConversationRepository } from "./backend/conversation-repository.js";
import { ConversationService } from "./backend/conversation-service.js";
import type { EncryptionService } from "./backend/encrypted-credential-store.js";
import { FakeConversationAgentFactory } from "./backend/fake-conversation-agent.js";
import { CompositeIntegrationToolSource } from "./backend/integration-tool-source.js";
import { McpService } from "./backend/mcp-service.js";
import { ModelPricingService } from "./backend/model-pricing-service.js";
import { ModelService } from "./backend/model-service.js";
import { PiConversationAgentFactory, SdkPiSessionFactory } from "./backend/pi-conversation-agent.js";
import { PluginService } from "./backend/plugin-service.js";
import { SessionReportService } from "./backend/session-report-service.js";
import type { StructuredLogger } from "./backend/structured-logger.js";
import { ToolAuditStore } from "./backend/tool-audit-store.js";
import { ToolAuthorizationBroker } from "./backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "./backend/tool-policy-store.js";
import type { UpdateService } from "./backend/update-service.js";
import type { HandlerIpcMain, SenderAuthorizer } from "./ipc/guarded-handlers.js";
import { registerConversationHandlers } from "./ipc/register-conversation-handlers.js";
import { registerAgentHandlers } from "./ipc/register-handlers.js";
import { registerMcpHandlers } from "./ipc/register-mcp-handlers.js";
import { registerModelSettingsHandlers } from "./ipc/register-model-settings-handlers.js";
import { registerPluginHandlers } from "./ipc/register-plugin-handlers.js";
import { registerSessionReportHandlers } from "./ipc/register-session-report-handlers.js";
import { registerToolPolicyHandlers } from "./ipc/register-tool-policy-handlers.js";
import { registerUpdateHandlers } from "./ipc/register-update-handlers.js";

/** Electron-specific capabilities the backend needs, injected so it can be composed and tested without Electron. */
export interface BackendHost {
  /** Root for every backend store: conversations, sessions, credentials, and policy. */
  dataDirectory: string;
  ipcMain: HandlerIpcMain;
  authorizeSender: SenderAuthorizer;
  /** Sends a push channel payload to every open renderer window. */
  broadcast: (channel: string, payload: unknown) => void;
  /** The window that should own a new tool approval prompt, or null when none is open. */
  selectApprovalWindowId: () => number | null;
  openExternal: (url: string) => Promise<void>;
  openReleasesPage: () => Promise<void>;
  encryption: EncryptionService;
  logger: StructuredLogger;
  agentMode: AgentMode;
  updateService: UpdateService;
  userName?: string;
  /** Refresh model catalogs over the network in the background after startup. Defaults to true. */
  allowModelNetwork?: boolean;
}

export interface Backend {
  /** Rejects pending approvals, stops integrations, removes IPC handlers, and disposes every agent. */
  dispose(): Promise<void>;
}

export async function createBackend(host: BackendHost): Promise<Backend> {
  const { dataDirectory, ipcMain, authorizeSender, broadcast, encryption, logger } = host;
  const modelService = await ModelService.create({
    dataDirectory,
    encryption,
    ...(host.allowModelNetwork === undefined ? {} : { allowModelNetwork: host.allowModelNetwork }),
  });
  const unsubscribeUpdateState = host.updateService.subscribe((state) =>
    broadcast(WISP_IPC_CHANNELS.updateState, state),
  );
  const toolPolicyStore = new ToolPolicyStore(path.join(dataDirectory, "tool-policy.json"));
  await toolPolicyStore.load();

  // The registry, broker, and conversation service reference each other through
  // events, so the late-bound ones are captured by these closures.
  let conversationService: ConversationService | undefined;
  let agentRegistry: AgentRegistry | undefined;
  const publishAgentEvent = (event: SequencedConversationAgentEvent): void => {
    conversationService?.handleAgentEvent(event);
    if (event.type === "conversation_error") {
      logger.warn("conversation_error", {
        conversationId: event.conversationId,
        requestId: event.requestId,
        code: event.error.code,
        retryable: event.error.retryable,
      });
    } else if (event.type === "tool_approval_requested" || event.type === "tool_approval_resolved") {
      logger.info(event.type, {
        conversationId: event.conversationId,
        approvalId: event.type === "tool_approval_requested" ? event.request.approvalId : event.approvalId,
      });
    }
    broadcast(WISP_IPC_CHANNELS.agentEvent, event);
  };
  const toolAuthorizationBroker = new ToolAuthorizationBroker(
    toolPolicyStore,
    (event) => agentRegistry?.publishExternalEvent(event),
    {
      selectWindowId: host.selectApprovalWindowId,
      audit: new ToolAuditStore(path.join(dataDirectory, "tool-audit.jsonl")),
    },
  );
  const conversationRepository = new ConversationRepository({ dataDirectory, userName: host.userName });
  const resolveWisp = (id: string): string => conversationRepository.getAgentContext(id).sessionId;
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
    openExternal: host.openExternal,
    // Health updates: push the sanitized view; secrets never leave the backend.
    onSettingsChanged: (view) => broadcast(WISP_IPC_CHANNELS.mcpSettingsChanged, view),
  });
  await mcpService.load();
  const agentFactory: ConversationAgentFactory =
    host.agentMode === "fake"
      ? new FakeConversationAgentFactory({ latencyMs: 350 })
      : new PiConversationAgentFactory(
          new SdkPiSessionFactory(
            modelService.getModelRuntime(),
            toolAuthorizationBroker,
            new CompositeIntegrationToolSource([pluginService, mcpService]),
          ),
        );
  const registry = new AgentRegistry(
    agentFactory,
    publishAgentEvent,
    (conversationId) => toolAuthorizationBroker.cancelConversation(conversationId),
    { validateModel: (selection) => modelService.validateConversationSelection(selection) },
  );
  agentRegistry = registry;
  const service = new ConversationService(
    conversationRepository,
    registry,
    () => toolAuthorizationBroker.listPending(),
    { logger, onChatChanged: (chat) => broadcast(WISP_IPC_CHANNELS.conversationChanged, chat) },
  );
  conversationService = service;
  await service.start(await modelService.getSelection());

  const sessionReportService = new SessionReportService(
    conversationRepository,
    new ModelPricingService({ cacheFilePath: path.join(dataDirectory, "model-pricing.json") }),
  );
  // Disposed in this order on shutdown: stop new work and integrations first,
  // then the agents, which may still be settling their last turn.
  const handlers = [
    registerToolPolicyHandlers(ipcMain, toolAuthorizationBroker, authorizeSender),
    registerPluginHandlers(ipcMain, pluginService, authorizeSender),
    registerMcpHandlers(ipcMain, mcpService, authorizeSender),
    registerUpdateHandlers(ipcMain, host.updateService, authorizeSender, host.openReleasesPage),
    registerModelSettingsHandlers(ipcMain, modelService, authorizeSender, (selection) => service.applyModel(selection)),
    registerSessionReportHandlers(ipcMain, sessionReportService, authorizeSender),
    registerConversationHandlers(ipcMain, service, authorizeSender),
  ];
  const agentHandlers = registerAgentHandlers(ipcMain, registry, authorizeSender, async (id, model) => {
    if (model) await modelService.validateConversationSelection(model);
    await service.applyConversationModel(id, model);
  });
  // Startup used the cached catalog; network updates land after the window opens.
  if (host.allowModelNetwork ?? true) {
    void refreshModelCatalog(modelService, (selection) => service.applyModel(selection), logger);
  }

  return {
    dispose: async () => {
      for (const registration of handlers) registration.dispose();
      modelService.dispose();
      pluginService.dispose();
      mcpService.dispose();
      unsubscribeUpdateState();
      toolAuthorizationBroker.dispose();
      await agentHandlers.dispose();
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
 * call that ignores its abort signal must not leave the app unable to quit.
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
