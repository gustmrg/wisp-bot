import type { ContextView } from "../../shared/context-policy.js";

import {
  WISP_IPC_CHANNELS,
  type BackendResult,
  type ConversationModelView,
  type ModelSelection,
  type EmptyResult,
} from "../../shared/contracts.js";
import type { AgentRegistry } from "../agent-registry.js";
import {
  registerAuthorizedHandlers,
  toBackendResult as toResult,
  type HandlerRouter,
  type SenderAuthorizer,
} from "./guarded-handlers.js";
import {
  parseContextRequest,
  parseApplyModelRequest,
  parseConversationRequest,
  parseSendMessageRequest,
} from "../validators.js";

const emptyValue: Record<string, never> = {};

export class AgentIpcController {
  private readonly registry: AgentRegistry;

  constructor(
    registry: AgentRegistry,
    private readonly saveModel: (id: string, model: ModelSelection | null) => Promise<void> = (id, model) =>
      registry.applyConversationModel(id, model),
  ) {
    this.registry = registry;
  }

  async start(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const { conversationId } = parseConversationRequest(payload);
      this.registry.get(conversationId);
      return emptyValue;
    });
  }

  async send(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const request = parseSendMessageRequest(payload);
      this.registry.dispatch(request);
      return emptyValue;
    });
  }

  async abort(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const { conversationId } = parseConversationRequest(payload);
      await this.registry.abort(conversationId);
      return emptyValue;
    });
  }

  async applyModel(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const request = parseApplyModelRequest(payload);
      await this.saveModel(request.conversationId, request.model);
      return emptyValue;
    });
  }

  async manageContext(payload: unknown): Promise<BackendResult<ContextView>> {
    return toResult(() => this.registry.manageContext(parseContextRequest(payload)));
  }

  async getModel(payload: unknown): Promise<BackendResult<ConversationModelView>> {
    return toResult(async () => this.registry.getModelView(parseConversationRequest(payload).conversationId));
  }

  async dispose(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const { conversationId } = parseConversationRequest(payload);
      await this.registry.delete(conversationId);
      return emptyValue;
    });
  }
}

export function registerAgentHandlers(
  router: HandlerRouter,
  registry: AgentRegistry,
  authorizeSender: SenderAuthorizer,
  saveModel?: (id: string, model: ModelSelection | null) => Promise<void>,
): { dispose: () => void } {
  const controller = new AgentIpcController(registry, saveModel);
  // The controller already returns BackendResults, so only the sender check is added here.
  return registerAuthorizedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.startConversation, (payload) => controller.start(payload)],
    [WISP_IPC_CHANNELS.sendMessage, (payload) => controller.send(payload)],
    [WISP_IPC_CHANNELS.abortConversation, (payload) => controller.abort(payload)],
    [WISP_IPC_CHANNELS.manageContext, (payload) => controller.manageContext(payload)],
    [WISP_IPC_CHANNELS.getConversationModel, (payload) => controller.getModel(payload)],
    [WISP_IPC_CHANNELS.applyModel, (payload) => controller.applyModel(payload)],
    [WISP_IPC_CHANNELS.disposeConversation, (payload) => controller.dispose(payload)],
  ]);
}
