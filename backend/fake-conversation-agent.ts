import type { ConversationAgentEvent, ModelSelection, SendMessageRequest } from "../shared/contracts.js";
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
  /** Let a running turn take follow-ups, which it reads, like Pi, once its wait is over. */
  steering?: boolean;
}

export class FakeConversationAgent implements ConversationAgent {
  private readonly conversationId: string;
  private readonly latencyMs: number;
  private readonly responseFor: (request: SendMessageRequest) => string;
  private readonly steering: boolean;
  /** Follow-ups handed to the running turn, oldest first. */
  private followUps: SendMessageRequest[] = [];
  private readonly listeners = new Set<ConversationAgentListener>();
  private readonly queue: PendingMessage[] = [];
  private activeAbortController: AbortController | undefined;
  private processing = false;
  private started = false;
  private disposed = false;
  private model: ModelSelection | undefined;
  /** What the Wisp's jobs delivered, in order, as its context would hold them. */
  readonly jobResults: string[] = [];

  constructor(conversationId: string, options: FakeConversationAgentOptions = {}) {
    this.conversationId = conversationId;
    this.latencyMs = options.latencyMs ?? 0;
    this.responseFor = options.responseFor ?? ((request) => `Fake response to: ${request.text}`);
    this.steering = options.steering ?? false;
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.started) return;
    this.started = true;
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
  }

  async rememberJobResult(text: string): Promise<void> {
    this.assertNotDisposed();
    this.jobResults.push(text);
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

  async steer(request: SendMessageRequest): Promise<boolean> {
    if (!this.steering || this.disposed || !this.activeAbortController || this.activeAbortController.signal.aborted)
      return false;
    this.followUps.push(request);
    return true;
  }

  withdrawFollowUps(): string[] {
    return this.followUps.splice(0).map(({ requestId }) => requestId);
  }

  async abort(): Promise<void> {
    this.assertNotDisposed();
    this.activeAbortController?.abort();
  }

  async updateContext(context: ConversationAgentContext): Promise<void> {
    this.assertNotDisposed();
    if (context.conversationId !== this.conversationId) {
      throw new WispBackendError("invalid_request", "The agent context does not match this conversation.");
    }
  }

  async applyModel(model: ModelSelection): Promise<void> {
    this.assertNotDisposed();
    this.model = model;
    this.emit({
      type: "conversation_model_changed",
      conversationId: this.conversationId,
      applied: model,
      pending: null,
    });
  }

  async clearModel(): Promise<void> {
    this.assertNotDisposed();
    this.model = undefined;
    this.emit({
      type: "conversation_model_changed",
      conversationId: this.conversationId,
      applied: null,
      pending: null,
    });
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
    const messageId = `${request.requestId}:assistant`;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "working" });
    this.emit({
      type: "assistant_message_started",
      conversationId: this.conversationId,
      requestId: request.requestId,
      messageId,
      createdAt: new Date().toISOString(),
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

    let current = request;
    for (;;) {
      const currentMessageId = `${current.requestId}:assistant`;
      this.emit({
        type: "assistant_text_delta",
        conversationId: this.conversationId,
        requestId: current.requestId,
        messageId: currentMessageId,
        delta: this.responseFor(current),
      });
      this.emit({
        type: "assistant_message_completed",
        conversationId: this.conversationId,
        requestId: current.requestId,
        messageId: currentMessageId,
      });
      const followUp = this.followUps.shift();
      if (!followUp) break;
      this.emit({
        type: "follow_up_taken",
        conversationId: this.conversationId,
        requestId: current.requestId,
        followUpId: followUp.requestId,
      });
      this.emit({
        type: "assistant_message_started",
        conversationId: this.conversationId,
        requestId: followUp.requestId,
        messageId: `${followUp.requestId}:assistant`,
        createdAt: new Date().toISOString(),
      });
      current = followUp;
    }
    this.emit({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
    this.activeAbortController = undefined;
  }

  private delay(signal: AbortSignal): Promise<void> {
    if (this.latencyMs <= 0 || signal.aborted) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.latencyMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
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
