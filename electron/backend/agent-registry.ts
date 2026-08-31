import type {
  ConversationAgentEvent,
  ModelSelection,
  SendMessageRequest,
} from "../../shared/contracts.js";
import type { ManagedConversationStatus } from "../../shared/conversations.js";
import { WispBackendError } from "./backend-error.js";
import type {
  ConversationAgent,
  ConversationAgentContext,
  ConversationAgentFactory,
} from "./conversation-agent.js";

interface AgentEntry {
  agent: ConversationAgent;
  unsubscribe: () => void;
  status: ManagedConversationStatus;
  commandQueue: Promise<void>;
}

type EventPublisher = (event: ConversationAgentEvent) => void;

export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly factory: ConversationAgentFactory;
  private readonly publish: EventPublisher;
  private model: ModelSelection | null = null;

  constructor(factory: ConversationAgentFactory, publish: EventPublisher) {
    this.factory = factory;
    this.publish = publish;
  }

  async restore(contexts: ReadonlyArray<ConversationAgentContext>, model: ModelSelection | null): Promise<void> {
    this.model = model;
    const wanted = new Set(contexts.map(({ conversationId }) => conversationId));
    await Promise.all([...this.entries.keys()]
      .filter((conversationId) => !wanted.has(conversationId))
      .map((conversationId) => this.delete(conversationId)));
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
    };
    entry.unsubscribe = agent.subscribe((event) => {
      if (event.type === "conversation_status") {
        entry.status = this.model || event.status === "disposed"
          ? event.status
          : "configuration_required";
      }
      this.publish(event);
    });
    this.entries.set(conversationId, entry);
    try {
      await agent.start();
      if (this.model) await agent.applyModel(this.model);
    } catch (error) {
      this.entries.delete(conversationId);
      entry.unsubscribe();
      await agent.dispose().catch(() => undefined);
      throw error;
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

  send(request: SendMessageRequest): Promise<void> {
    const entry = this.require(request.conversationId);
    const operation = entry.commandQueue.then(() => entry.agent.send(request));
    entry.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  async abort(conversationId: string): Promise<void> {
    await this.require(conversationId).agent.abort();
  }

  async applyModel(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await Promise.all([...this.entries.values()].map(async (entry) => {
      if (!model) {
        entry.status = "configuration_required";
        return;
      }
      await entry.agent.applyModel(model);
      if (entry.status === "configuration_required") entry.status = "idle";
    }));
  }

  async delete(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
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
}
