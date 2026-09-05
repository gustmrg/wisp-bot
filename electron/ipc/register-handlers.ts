import type { ContextView } from "../../shared/context-policy.js";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  WISP_IPC_CHANNELS,
  type BackendResult,
  type ConversationModelView,
  type ModelSelection,
  type EmptyResult,
} from "../../shared/contracts.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { AgentRegistry } from "../backend/agent-registry.js";
import {
  parseContextRequest,
  parseApplyModelRequest,
  parseConversationRequest,
  parseSendMessageRequest,
} from "./validators.js";

type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
export type SenderAuthorizer = (event: IpcMainInvokeEvent) => boolean;

const emptyValue: Record<string, never> = {};

async function toResult<T>(operation: () => Promise<T>): Promise<BackendResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: sanitizeBackendError(error) };
  }
}

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

  async disposeAll(): Promise<void> {
    await this.registry.disposeAll();
  }
}

export function registerAgentHandlers(
  ipcMain: HandlerIpcMain,
  registry: AgentRegistry,
  authorizeSender: SenderAuthorizer,
  saveModel?: (id: string, model: ModelSelection | null) => Promise<void>,
): { dispose: () => Promise<void> } {
  const controller = new AgentIpcController(registry, saveModel);
  const registrations: ReadonlyArray<
    readonly [
      string,
      (payload: unknown) => Promise<EmptyResult | BackendResult<ConversationModelView> | BackendResult<ContextView>>,
    ]
  > = [
    [WISP_IPC_CHANNELS.startConversation, (payload) => controller.start(payload)],
    [WISP_IPC_CHANNELS.sendMessage, (payload) => controller.send(payload)],
    [WISP_IPC_CHANNELS.abortConversation, (payload) => controller.abort(payload)],
    [WISP_IPC_CHANNELS.manageContext, (payload) => controller.manageContext(payload)],
    [WISP_IPC_CHANNELS.getConversationModel, (payload) => controller.getModel(payload)],
    [WISP_IPC_CHANNELS.applyModel, (payload) => controller.applyModel(payload)],
    [WISP_IPC_CHANNELS.disposeConversation, (payload) => controller.dispose(payload)],
  ];

  for (const [channel, handler] of registrations) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!authorizeSender(event)) {
        return Promise.resolve<EmptyResult>({
          ok: false,
          error: {
            code: "invalid_request",
            message: "The backend request is invalid.",
            retryable: false,
          },
        });
      }
      return handler(payload);
    });
  }

  return {
    dispose: async () => {
      for (const [channel] of registrations) ipcMain.removeHandler(channel);
      await controller.disposeAll();
    },
  };
}
