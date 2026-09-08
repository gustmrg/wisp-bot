import path from "node:path";
import type { AiSettingsStore } from "./ai-settings-store.js";

import type { BackendApi } from "../shared/backend-api.js";
import type { BackendResult, ModelSelection, SequencedConversationAgentEvent } from "../shared/contracts.js";
import type { ConversationStateView } from "../shared/conversations.js";
import * as validators from "../shared/validators.js";
import { AgentRegistry } from "./agent-registry.js";
import type { AgentMode } from "./agent-mode.js";
import { sanitizeBackendError } from "./backend-error.js";
import { ConversationRepository, type ConversationStorage } from "./conversation-repository.js";
import { ConversationService } from "./conversation-service.js";
import type { EncryptionService } from "./encrypted-credential-store.js";
import { FakeConversationAgentFactory } from "./fake-conversation-agent.js";
import { ModelPricingService } from "./model-pricing-service.js";
import { ModelService } from "./model-service.js";
import { PiConversationAgentFactory, SdkPiSessionFactory } from "./pi-conversation-agent.js";
import { SessionReportService } from "./session-report-service.js";
import { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { ToolAuditStore } from "./tool-audit-store.js";
import { ToolPolicyStore } from "./tool-policy-store.js";

export interface BackendOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  aiSettings?: Pick<AiSettingsStore, "getSelection" | "setSelection">;
  userName?: string;
  agentMode?: AgentMode;
  repository?: ConversationStorage;
  publishEvent?: (event: SequencedConversationAgentEvent) => void;
  manageAgentPersistence?: boolean;
  authorizationBroker?: ToolAuthorizationBroker;
  approvalPrincipal?: number;
  fakeLatencyMs?: number;
}

export interface BackendRuntime {
  api: BackendApi;
  conversations: ConversationService;
  repository: ConversationStorage;
  registry: AgentRegistry;
  models: ModelService;
  toolAuthorization: ToolAuthorizationBroker;
  reports: SessionReportService;
  dispose(): Promise<void>;
}

/** Creates a runtime owned by its host, independently of any window or network connection. */
export async function createBackend(options: BackendOptions): Promise<BackendRuntime> {
  const fake = options.agentMode === "fake";
  const fakeSelection: ModelSelection = { providerId: "fake", modelId: "deterministic" };
  const models = await ModelService.create(options);
  const repository = options.repository ?? new ConversationRepository(options);
  const policy = new ToolPolicyStore(path.join(options.dataDirectory, "tool-policy.json"));
  await policy.load();
  const listeners = new Set<(event: SequencedConversationAgentEvent) => void>();
  const stateListeners = new Set<(state: ConversationStateView) => void>();
  let registry: AgentRegistry;
  let conversations: ConversationService | undefined;
  const publish = (event: SequencedConversationAgentEvent): void => {
    if (options.manageAgentPersistence !== false) conversations?.handleAgentEvent(event);
    options.publishEvent?.(event);
    for (const listener of listeners) listener(event);
  };
  const toolAuthorization =
    options.authorizationBroker ??
    new ToolAuthorizationBroker(policy, (event) => registry?.publishExternalEvent(event), {
      selectWindowId: () => options.approvalPrincipal ?? 1,
      audit: new ToolAuditStore(path.join(options.dataDirectory, "tool-audit.jsonl")),
    });
  registry = new AgentRegistry(
    fake
      ? new FakeConversationAgentFactory({ latencyMs: options.fakeLatencyMs ?? 50 })
      : new PiConversationAgentFactory(new SdkPiSessionFactory(models.getModelRuntime(), toolAuthorization)),
    publish,
    (conversationId) => toolAuthorization.cancelConversation(conversationId),
    { validateModel: fake ? async () => undefined : (selection) => models.validateConversationSelection(selection) },
  );
  conversations = new ConversationService(repository, registry, () => toolAuthorization.listPending());
  const service = conversations;
  await service.start(fake ? fakeSelection : await models.getSelection());
  const reports = new SessionReportService(
    repository,
    new ModelPricingService({ cacheFilePath: path.join(options.dataDirectory, "model-pricing.json") }),
  );
  const result = async <T>(operation: () => T | Promise<T>): Promise<BackendResult<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: sanitizeBackendError(error) };
    }
  };
  const mutation = <T>(operation: () => T | Promise<T>): Promise<BackendResult<T>> =>
    result(async () => {
      const value = await operation();
      const state = service.getState();
      for (const listener of stateListeners) listener(state);
      return value;
    });
  const api: BackendApi = {
    startConversation: (request) =>
      result(() => {
        registry.get(validators.parseConversationRequest(request).conversationId);
        return {};
      }),
    sendMessage: (request) =>
      result(() => {
        registry.dispatch(validators.parseSendMessageRequest(request));
        return {};
      }),
    abortConversation: (request) =>
      result(async () => {
        await registry.abort(validators.parseConversationRequest(request).conversationId);
        return {};
      }),
    disposeConversation: (request) =>
      mutation(async () => {
        await registry.delete(validators.parseConversationRequest(request).conversationId);
        return {};
      }),
    applyModel: (payload) =>
      mutation(async () => {
        const request = validators.parseApplyModelRequest(payload);
        if (request.model && !fake) await models.validateConversationSelection(request.model);
        await service.applyConversationModel(request.conversationId, request.model);
        return {};
      }),
    getConversationModel: (request) =>
      result(() => service.getConversationModel(validators.parseConversationRequest(request).conversationId)),
    manageContext: (request) => mutation(() => registry.manageContext(validators.parseContextRequest(request))),
    subscribeToAgentEvents: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeToConversationState: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    refreshConnection: () => result(() => service.getState()),
    getConversationState: () => result(() => service.getState()),
    initializeConversations: (request) =>
      mutation(() => service.initialize(validators.parseInitializeConversationsRequest(request).chats)),
    createConversation: (request) =>
      mutation(() => service.create(validators.parseCreateConversationRequest(request).conversation)),
    updateConversation: (payload) =>
      mutation(() => {
        const request = validators.parseUpdateConversationRequest(payload);
        return service.update(request.conversationId, request.changes);
      }),
    deleteConversation: (request) =>
      mutation(() => service.delete(validators.parseDeleteConversationRequest(request).conversationId)),
    appendConversationMessage: (payload) =>
      mutation(() => {
        const request = validators.parseAppendConversationMessageRequest(payload);
        return service.appendMessage(request.conversationId, request.message);
      }),
    answerConversationPrompt: (payload) =>
      mutation(() => {
        const request = validators.parseAnswerConversationPromptRequest(payload);
        return service.answerPrompt(request.conversationId, request.messageId, request.answer);
      }),
    markConversationRead: (request) =>
      mutation(() => service.markRead(validators.parseMarkConversationReadRequest(request).conversationId)),
    getAiSettings: () =>
      result(async () => {
        const view = await models.getView();
        return fake
          ? {
              ...view,
              selection: fakeSelection,
              providers: [
                {
                  id: "fake",
                  name: "Deterministic test agent",
                  credentialConfigured: true,
                  models: [
                    {
                      id: "deterministic",
                      name: "Fake agent",
                      reasoning: false,
                      input: ["text" as const],
                      contextWindow: 32000,
                      maxOutputTokens: 4000,
                    },
                  ],
                },
              ],
            }
          : view;
      }),
    saveAiSettings: (request) =>
      mutation(async () => {
        const view = await models.save(validators.parseSaveAiSettingsRequest(request));
        await service.applyModel(view.selection);
        return view;
      }),
    removeProviderCredential: (request) =>
      mutation(async () => {
        const view = await models.removeCredential(validators.parseRemoveProviderCredentialRequest(request).providerId);
        await service.applyModel(view.selection);
        return view;
      }),
    getToolPolicy: () => result(() => toolAuthorization.getPolicy()),
    saveToolPolicy: (request) => mutation(() => toolAuthorization.savePolicy(request)),
    resolveToolApproval: (request) =>
      result(async () => {
        await toolAuthorization.resolve(
          validators.parseResolveToolApprovalRequest(request),
          options.approvalPrincipal ?? 1,
        );
        return {};
      }),
    getSessionReport: (request) =>
      result(() => reports.getSessionReport(validators.parseConversationRequest(request).conversationId)),
    getUsageReport: (request) => result(() => reports.getUsageReport(validators.parseUsageReportRequest(request))),
  };
  let disposing: Promise<void> | undefined;
  return {
    api,
    conversations: service,
    repository,
    registry,
    models,
    toolAuthorization,
    reports,
    dispose() {
      disposing ??= (async () => {
        toolAuthorization.dispose();
        await registry.disposeAll();
        listeners.clear();
        stateListeners.clear();
      })();
      return disposing;
    },
  };
}
