import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  WISP_IPC_CHANNELS,
  type BackendResult,
  type EmptyResult,
} from "../../shared/contracts.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { AgentRegistry } from "../backend/agent-registry.js";
import {
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

  constructor(registry: AgentRegistry) {
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
      await this.registry.applyModel(request.model);
      return emptyValue;
    });
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
): { dispose: () => Promise<void> } {
  const controller = new AgentIpcController(registry);
  const registrations: ReadonlyArray<readonly [string, (payload: unknown) => Promise<EmptyResult>]> = [
    [WISP_IPC_CHANNELS.startConversation, (payload) => controller.start(payload)],
    [WISP_IPC_CHANNELS.sendMessage, (payload) => controller.send(payload)],
    [WISP_IPC_CHANNELS.abortConversation, (payload) => controller.abort(payload)],
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
