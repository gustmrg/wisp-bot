import type {
  ConversationAgentEvent,
  ModelSelection,
  SequencedConversationAgentEvent,
  SendMessageRequest,
} from "../../shared/contracts.js";
import type { ManagedConversationStatus } from "../../shared/conversations.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationAgent, ConversationAgentContext, ConversationAgentFactory } from "./conversation-agent.js";

interface AgentEntry {
  agent: ConversationAgent;
  unsubscribe: () => void;
  status: ManagedConversationStatus;
  commandQueue: Promise<void>;
  reportedRequestErrors: Set<string>;
  pendingCommands: number;
  acceptedRequestIds: Set<string>;
  suppressedCancellationIds: Set<string>;
  disposed: boolean;
}

const MAX_PENDING_COMMANDS_PER_CONVERSATION = 8;
const MAX_SIMULTANEOUS_AGENTS = 4;
const MAX_REMEMBERED_REQUEST_IDS = 1_024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1_000;

export interface AgentRegistryOptions {
  executionTimeoutMs?: number;
}

type EventPublisher = (event: SequencedConversationAgentEvent) => void;

export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly factory: ConversationAgentFactory;
  private readonly publish: EventPublisher;
  private readonly onConversationDisposed: (conversationId: string) => void;
  private readonly executionTimeoutMs: number;
  private model: ModelSelection | null = null;
  private eventSequence = 0;
  private activeAgents = 0;
  private readonly activeWaiters: Array<() => void> = [];

  constructor(
    factory: ConversationAgentFactory,
    publish: EventPublisher,
    onConversationDisposed: (conversationId: string) => void = () => undefined,
    options: AgentRegistryOptions = {},
  ) {
    this.factory = factory;
    this.publish = publish;
    this.onConversationDisposed = onConversationDisposed;
    this.executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  }

  async restore(contexts: ReadonlyArray<ConversationAgentContext>, model: ModelSelection | null): Promise<void> {
    this.model = model;
    const wanted = new Set(contexts.map(({ conversationId }) => conversationId));
    await Promise.all(
      [...this.entries.keys()]
        .filter((conversationId) => !wanted.has(conversationId))
        .map((conversationId) => this.delete(conversationId)),
    );
    await Promise.all(contexts.map((context) => this.create(context)));
  }

  async create(context: ConversationAgentContext): Promise<void> {
    const { conversationId } = context;
    if (this.entries.has(conversationId)) return;
    const agent = this.factory.create(context);
    const entry: AgentEntry = {
      agent,
      unsubscribe: () => undefined,
      status: this.model ? "idle" : "configuration_required",
      commandQueue: Promise.resolve(),
      reportedRequestErrors: new Set(),
      pendingCommands: 0,
      acceptedRequestIds: new Set(),
      suppressedCancellationIds: new Set(),
      disposed: false,
    };
    entry.unsubscribe = agent.subscribe((event) => {
      if (event.type === "assistant_message_cancelled" && entry.suppressedCancellationIds.delete(event.requestId)) {
        return;
      }
      if (event.type === "conversation_status") {
        entry.status = this.model || event.status === "disposed" ? event.status : "configuration_required";
      }
      if (event.type === "conversation_error" && event.requestId) {
        entry.reportedRequestErrors.add(event.requestId);
      }
      this.publishEvent(event);
    });
    this.entries.set(conversationId, entry);
    try {
      await agent.start();
    } catch (error) {
      this.entries.delete(conversationId);
      entry.unsubscribe();
      await agent.dispose().catch(() => undefined);
      throw error;
    }
    if (this.model) {
      try {
        await agent.applyModel(this.model);
      } catch (error) {
        entry.status = "configuration_required";
        this.publishEvent({
          type: "conversation_error",
          conversationId,
          createdAt: new Date().toISOString(),
          error: sanitizeBackendError(error),
        });
      }
    }
  }

  has(conversationId: string): boolean {
    return this.entries.has(conversationId);
  }

  get(conversationId: string): ConversationAgent {
    return this.require(conversationId).agent;
  }

  list(): ReadonlyArray<string> {
    return [...this.entries.keys()];
  }

  statuses(): Record<string, ManagedConversationStatus> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.status]));
  }

  getEventSequence(): number {
    return this.eventSequence;
  }

  publishExternalEvent(event: ConversationAgentEvent): void {
    if (!this.entries.has(event.conversationId)) return;
    this.publishEvent(event);
  }

  send(request: SendMessageRequest): Promise<void> {
    const entry = this.require(request.conversationId);
    if (entry.acceptedRequestIds.has(request.requestId)) {
      throw new WispBackendError("invalid_request", "This request ID has already been accepted.");
    }
    if (entry.pendingCommands >= MAX_PENDING_COMMANDS_PER_CONVERSATION) {
      throw new WispBackendError("invalid_request", "This conversation already has too many queued requests.");
    }
    rememberRequestId(entry.acceptedRequestIds, request.requestId);
    entry.pendingCommands += 1;
    const operation = entry.commandQueue
      .then(async () => {
        await this.acquireActiveSlot();
        try {
          if (entry.disposed) {
            throw new WispBackendError("disposed", "The conversation was deleted before this request could run.");
          }
          await this.sendWithDeadline(entry, request);
        } finally {
          this.releaseActiveSlot();
        }
      })
      .finally(() => {
        entry.pendingCommands -= 1;
      });
    entry.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  private async sendWithDeadline(entry: AgentEntry, request: SendMessageRequest): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        entry.suppressedCancellationIds.add(request.requestId);
        reject(new WispBackendError("aborted", "The model request timed out.", true));
        void entry.agent
          .abort()
          .catch(() => undefined)
          .finally(() => entry.suppressedCancellationIds.delete(request.requestId));
      }, this.executionTimeoutMs);
    });
    try {
      await Promise.race([entry.agent.send(request), deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (!timedOut) entry.suppressedCancellationIds.delete(request.requestId);
    }
  }

  dispatch(request: SendMessageRequest): void {
    const entry = this.require(request.conversationId);
    void this.send(request)
      .catch((error) => {
        if (this.entries.get(request.conversationId) !== entry) return;
        if (entry.reportedRequestErrors.has(request.requestId)) return;
        this.publishEvent({
          type: "conversation_error",
          conversationId: request.conversationId,
          requestId: request.requestId,
          createdAt: new Date().toISOString(),
          error: sanitizeBackendError(error),
        });
      })
      .finally(() => entry.reportedRequestErrors.delete(request.requestId));
  }

  async abort(conversationId: string): Promise<void> {
    await this.require(conversationId).agent.abort();
  }

  async updateContext(context: ConversationAgentContext): Promise<void> {
    await this.require(context.conversationId).agent.updateContext(context);
  }

  async applyModel(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (!model) {
          await entry.agent.clearModel();
          entry.status = "configuration_required";
          return;
        }
        try {
          await entry.agent.applyModel(model);
          if (entry.status === "configuration_required") entry.status = "idle";
        } catch (error) {
          entry.status = "configuration_required";
          throw error;
        }
      }),
    );
  }

  async delete(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
    entry.disposed = true;
    this.onConversationDisposed(conversationId);
    entry.unsubscribe();
    await entry.agent.dispose();
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.allSettled(ids.map((conversationId) => this.delete(conversationId)));
  }

  private require(conversationId: string): AgentEntry {
    const entry = this.entries.get(conversationId);
    if (!entry) throw new WispBackendError("not_found", "The conversation is not running.");
    return entry;
  }

  private publishEvent(event: ConversationAgentEvent): void {
    this.eventSequence += 1;
    this.publish({ ...event, sequence: this.eventSequence });
  }

  private acquireActiveSlot(): Promise<void> {
    if (this.activeAgents < MAX_SIMULTANEOUS_AGENTS) {
      this.activeAgents += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.activeWaiters.push(() => {
        this.activeAgents += 1;
        resolve();
      });
    });
  }

  private releaseActiveSlot(): void {
    this.activeAgents -= 1;
    this.activeWaiters.shift()?.();
  }
}

function rememberRequestId(requestIds: Set<string>, requestId: string): void {
  requestIds.add(requestId);
  if (requestIds.size <= MAX_REMEMBERED_REQUEST_IDS) return;
  const oldest = requestIds.values().next().value;
  if (oldest !== undefined) requestIds.delete(oldest);
}
