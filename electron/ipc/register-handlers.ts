import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  WISP_IPC_CHANNELS,
  type BackendResult,
  type ConversationAgentEvent,
  type EmptyResult,
} from "../../shared/contracts.js";
import { sanitizeBackendError, WispBackendError } from "../backend/backend-error.js";
import type { ConversationAgent, ConversationAgentFactory } from "../backend/conversation-agent.js";
import {
  parseApplyModelRequest,
  parseConversationRequest,
  parseSendMessageRequest,
} from "./validators.js";

interface AgentEntry {
  agent: ConversationAgent;
  unsubscribe: () => void;
}

type EventPublisher = (event: ConversationAgentEvent) => void;
type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
type SenderAuthorizer = (event: IpcMainInvokeEvent) => boolean;

const emptyValue: Record<string, never> = {};

async function toResult<T>(operation: () => Promise<T>): Promise<BackendResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: sanitizeBackendError(error) };
  }
}

export class AgentIpcController {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly factory: ConversationAgentFactory;
  private readonly publish: EventPublisher;

  constructor(factory: ConversationAgentFactory, publish: EventPublisher) {
    this.factory = factory;
    this.publish = publish;
  }

  async start(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const { conversationId } = parseConversationRequest(payload);
      if (this.agents.has(conversationId)) return emptyValue;

      const agent = this.factory.create(conversationId);
      const unsubscribe = agent.subscribe(this.publish);
      this.agents.set(conversationId, { agent, unsubscribe });
      try {
        await agent.start();
      } catch (error) {
        unsubscribe();
        this.agents.delete(conversationId);
        await agent.dispose();
        throw error;
      }
      return emptyValue;
    });
  }

  async send(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const request = parseSendMessageRequest(payload);
      await this.getAgent(request.conversationId).send(request);
      return emptyValue;
    });
  }

  async abort(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const { conversationId } = parseConversationRequest(payload);
      await this.getAgent(conversationId).abort();
      return emptyValue;
    });
  }

  async applyModel(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const request = parseApplyModelRequest(payload);
      await this.getAgent(request.conversationId).applyModel(request.model);
      return emptyValue;
    });
  }

  async dispose(payload: unknown): Promise<EmptyResult> {
    return toResult(async () => {
      const { conversationId } = parseConversationRequest(payload);
      const entry = this.agents.get(conversationId);
      if (!entry) return emptyValue;
      this.agents.delete(conversationId);
      entry.unsubscribe();
      await entry.agent.dispose();
      return emptyValue;
    });
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(entries.map(async ({ agent, unsubscribe }) => {
      unsubscribe();
      await agent.dispose();
    }));
  }

  private getAgent(conversationId: string): ConversationAgent {
    const entry = this.agents.get(conversationId);
    if (!entry) {
      throw new WispBackendError("not_found", "The conversation is not running.");
    }
    return entry.agent;
  }
}

export function registerAgentHandlers(
  ipcMain: HandlerIpcMain,
  factory: ConversationAgentFactory,
  publish: EventPublisher,
  authorizeSender: SenderAuthorizer,
): { dispose: () => Promise<void> } {
  const controller = new AgentIpcController(factory, publish);
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
