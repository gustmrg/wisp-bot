import type {
  ConversationAgentEvent,
  ModelSelection,
  SendMessageRequest,
} from "../../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type {
  ConversationAgent,
  ConversationAgentContext,
  ConversationAgentFactory,
  ConversationAgentListener,
} from "./conversation-agent.js";

interface PendingMessage {
  request: SendMessageRequest;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface FakeConversationAgentOptions {
  latencyMs?: number;
  responseFor?: (request: SendMessageRequest) => string;
}

export class FakeConversationAgent implements ConversationAgent {
  private readonly conversationId: string;
  private readonly latencyMs: number;
  private readonly responseFor: (request: SendMessageRequest) => string;
  private readonly listeners = new Set<ConversationAgentListener>();
  private readonly queue: PendingMessage[] = [];
  private activeAbortController: AbortController | undefined;
  private processing = false;
  private started = false;
  private disposed = false;
  private model: ModelSelection | undefined;

  constructor(conversationId: string, options: FakeConversationAgentOptions = {}) {
    this.conversationId = conversationId;
    this.latencyMs = options.latencyMs ?? 0;
    this.responseFor = options.responseFor ?? ((request) => `Fake response to: ${request.text}`);
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.started) return;
    this.started = true;
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
  }

  send(request: SendMessageRequest): Promise<void> {
    this.assertNotDisposed();
    if (!this.started) {
      throw new WispBackendError("invalid_request", "The conversation has not been started.");
    }
    if (request.conversationId !== this.conversationId) {
      throw new WispBackendError("invalid_request", "The request does not match this conversation.");
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      void this.processQueue();
    });
  }

  async abort(): Promise<void> {
    this.assertNotDisposed();
    this.activeAbortController?.abort();
  }

  async applyModel(model: ModelSelection): Promise<void> {
    this.assertNotDisposed();
    this.model = model;
  }

  async clearModel(): Promise<void> {
    this.assertNotDisposed();
    this.model = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.activeAbortController?.abort();
    const error = new WispBackendError("disposed", "The conversation has been disposed.");
    for (const pending of this.queue.splice(0)) pending.reject(error);
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "disposed" });
    this.listeners.clear();
  }

  subscribe(listener: ConversationAgentListener): () => void {
    this.assertNotDisposed();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get selectedModel(): ModelSelection | undefined {
    return this.model;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;

    try {
      while (!this.disposed) {
        const pending = this.queue.shift();
        if (!pending) break;

        try {
          await this.processMessage(pending.request);
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async processMessage(request: SendMessageRequest): Promise<void> {
    const messageId = `fake-${request.requestId}`;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "working" });
    this.emit({
      type: "assistant_message_started",
      conversationId: this.conversationId,
      requestId: request.requestId,
      messageId,
    });

    await this.delay(abortController.signal);

    if (abortController.signal.aborted || this.disposed) {
      this.emit({
        type: "assistant_message_cancelled",
        conversationId: this.conversationId,
        requestId: request.requestId,
        messageId,
      });
      if (!this.disposed) {
        this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
      }
      this.activeAbortController = undefined;
      return;
    }

    this.emit({
      type: "assistant_text_delta",
      conversationId: this.conversationId,
      requestId: request.requestId,
      messageId,
      delta: this.responseFor(request),
    });
    this.emit({
      type: "assistant_message_completed",
      conversationId: this.conversationId,
      requestId: request.requestId,
      messageId,
    });
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
    this.activeAbortController = undefined;
  }

  private delay(signal: AbortSignal): Promise<void> {
    if (this.latencyMs <= 0 || signal.aborted) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.latencyMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new WispBackendError("disposed", "The conversation has been disposed.");
    }
  }

  private emit(event: ConversationAgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class FakeConversationAgentFactory implements ConversationAgentFactory {
  private readonly options: FakeConversationAgentOptions;

  constructor(options: FakeConversationAgentOptions = {}) {
    this.options = options;
  }

  create(context: ConversationAgentContext): ConversationAgent {
    return new FakeConversationAgent(context.conversationId, this.options);
  }
}
