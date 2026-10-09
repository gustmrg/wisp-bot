import type { ContextRequest, ContextView } from "../shared/context-policy.js";
import type {
  ConversationAgentEvent,
  ConversationModelView,
  ModelSelection,
  SequencedConversationAgentEvent,
  SendMessageRequest,
} from "../shared/contracts.js";
import type { ManagedConversationStatus } from "../shared/conversations.js";
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
  override: ModelSelection | null;
  effective: ModelSelection | null;
  applied: ModelSelection | null;
  pending: ModelSelection | null;
  ready: boolean;
  modelQueue: Promise<void>;
}

const MAX_PENDING_COMMANDS_PER_CONVERSATION = 8;
const MAX_SIMULTANEOUS_AGENTS = 4;
const MAX_REMEMBERED_REQUEST_IDS = 1_024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1_000;

export interface AgentRegistryOptions {
  executionTimeoutMs?: number;
  validateModel?: (model: ModelSelection) => Promise<void>;
  /** Called when a conversation becomes free to take a request: configured, with nothing running or queued. */
  onAvailable?: (conversationId: string) => void;
  /** Whether files are being removed from the conversation's workspace; nothing runs there meanwhile. */
  isWorkspaceLocked?: (conversationId: string) => boolean;
}

type EventPublisher = (event: SequencedConversationAgentEvent) => void;

export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly factory: ConversationAgentFactory;
  private readonly publish: EventPublisher;
  private readonly onConversationDisposed: (conversationId: string) => void;
  private readonly executionTimeoutMs: number;
  private readonly validateModel: (model: ModelSelection) => Promise<void>;
  private readonly onAvailable: (conversationId: string) => void;
  private readonly isWorkspaceLocked: (conversationId: string) => boolean;
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
    this.validateModel = options.validateModel ?? (async () => undefined);
    this.onAvailable = options.onAvailable ?? (() => undefined);
    this.isWorkspaceLocked = options.isWorkspaceLocked ?? (() => false);
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
      status: "configuration_required",
      override: context.modelOverride ?? null,
      effective: context.modelOverride ?? this.model,
      applied: null,
      pending: null,
      ready: false,
      modelQueue: Promise.resolve(),
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
        if (event.status === "configuration_required") entry.ready = false;
        entry.status = entry.ready || event.status === "disposed" ? event.status : "configuration_required";
        this.publishEvent({ ...event, status: entry.status });
        return;
      }
      if (event.type === "conversation_model_changed") {
        entry.applied = event.applied;
        entry.pending = event.pending;
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
    await this.updateEntryModel(conversationId, entry);
  }

  has(conversationId: string): boolean {
    return this.entries.has(conversationId);
  }

  /** Whether the conversation is configured, has no request running or queued, and its workspace is not locked. */
  isAvailable(conversationId: string): boolean {
    const entry = this.entries.get(conversationId);
    return Boolean(
      entry && entry.ready && !entry.disposed && entry.pendingCommands === 0 && !this.isWorkspaceLocked(conversationId),
    );
  }

  /** Whether a request is running or queued for the conversation. */
  isBusy(conversationId: string): boolean {
    const entry = this.entries.get(conversationId);
    return Boolean(entry && !entry.disposed && entry.pendingCommands > 0);
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
    if (!entry.ready)
      throw new WispBackendError("configuration_required", "Configure a provider and model before sending a message.");
    if (entry.acceptedRequestIds.has(request.requestId)) {
      throw new WispBackendError("invalid_request", "This request ID has already been accepted.");
    }
    this.assertWorkspaceUnlocked(request.conversationId);
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
      .finally(() => this.settleCommand(request.conversationId, entry));
    entry.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  private assertWorkspaceUnlocked(conversationId: string): void {
    if (this.isWorkspaceLocked(conversationId)) {
      throw new WispBackendError(
        "unavailable",
        "This Wisp's workspace is being cleaned up. Try again in a moment.",
        true,
      );
    }
  }

  private settleCommand(conversationId: string, entry: AgentEntry): void {
    entry.pendingCommands -= 1;
    if (this.entries.get(conversationId) === entry && this.isAvailable(conversationId))
      this.onAvailable(conversationId);
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

  /** Sends without throwing: failures become error events. Resolves once the request has finished. */
  dispatch(request: SendMessageRequest): Promise<void> {
    const entry = this.require(request.conversationId);
    return this.send(request)
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

  async manageContext(request: ContextRequest): Promise<ContextView> {
    const entry = this.require(request.conversationId);
    if (!entry.agent.manageContext)
      throw new WispBackendError("configuration_required", "Context management requires a configured Pi session.");
    if (request.command.action === "get") return entry.agent.manageContext(request.command);
    if (entry.pendingCommands || entry.status === "working")
      throw new WispBackendError("invalid_request", "Wait for the Wisp to finish before changing its context.");
    this.assertWorkspaceUnlocked(request.conversationId);
    entry.pendingCommands += 1;
    const operation = entry.commandQueue
      .then(async () => {
        await this.acquireActiveSlot();
        try {
          if (entry.disposed) throw new WispBackendError("disposed", "The Wisp was deleted.");
          this.publishEvent({ type: "conversation_status", conversationId: request.conversationId, status: "working" });
          entry.status = "working";
          const timeout = setTimeout(() => {
            void entry.agent.abort().catch(() => undefined);
          }, this.executionTimeoutMs);
          try {
            return await entry.agent.manageContext!(request.command);
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          this.releaseActiveSlot();
          if (!entry.disposed) {
            entry.status = entry.ready ? "idle" : "configuration_required";
            this.publishEvent({
              type: "conversation_status",
              conversationId: request.conversationId,
              status: entry.status,
            });
          }
        }
      })
      .finally(() => this.settleCommand(request.conversationId, entry));
    entry.commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  getModelView(conversationId: string): ConversationModelView {
    const entry = this.require(conversationId);
    return structuredClone({
      override: entry.override,
      effective: entry.effective,
      applied: entry.applied,
      pending: entry.pending,
      status: entry.status,
    });
  }

  async applyConversationModel(conversationId: string, model: ModelSelection | null): Promise<void> {
    const entry = this.require(conversationId);
    entry.override = model;
    await this.updateEntryModel(conversationId, entry);
  }

  async applyModel(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await Promise.all([...this.entries].map(([id, entry]) => this.updateEntryModel(id, entry)));
  }

  private updateEntryModel(conversationId: string, entry: AgentEntry): Promise<void> {
    const operation = entry.modelQueue.then(async () => {
      if (entry.disposed) return;
      const model = entry.override ?? this.model;
      entry.effective = model;
      try {
        if (model) {
          await this.validateModel(model);
          await entry.agent.applyModel(model);
          entry.ready = true;
          if (entry.status === "configuration_required") entry.status = "idle";
        } else {
          await entry.agent.clearModel();
          entry.ready = false;
          entry.status = "configuration_required";
        }
      } catch (error) {
        entry.ready = false;
        entry.status = "configuration_required";
        await entry.agent.clearModel().catch(() => undefined);
        this.publishEvent({
          type: "conversation_error",
          conversationId,
          createdAt: new Date().toISOString(),
          error: sanitizeBackendError(error),
        });
      }
      this.publishEvent({ type: "conversation_status", conversationId, status: entry.status });
      if (this.isAvailable(conversationId)) this.onAvailable(conversationId);
    });
    entry.modelQueue = operation.catch(() => undefined);
    return operation;
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
