import type { ConversationModelView, ModelSelection, SequencedConversationAgentEvent } from "../../shared/contracts.js";
import type { Chat, ChatChanges, ChatCollection, ConversationStateView, Message } from "../../shared/conversations.js";
import type { ToolApprovalRequest } from "../../shared/tool-policy.js";
import type { AgentRegistry } from "./agent-registry.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { StructuredLogger } from "./structured-logger.js";

export interface ConversationServiceOptions {
  /** Receives a chat after agent-driven changes to it are persisted, so the renderer never re-fetches everything. */
  onChatChanged?: (chat: Chat) => void;
  logger?: Pick<StructuredLogger, "warn">;
}

/**
 * The main process is the only writer of agent-driven conversation state
 * (reply text, outgoing delivery status, context notices). The renderer writes
 * only what the user authored and applies these changes as they are pushed.
 */
export class ConversationService {
  private readonly repository: ConversationRepository;
  private readonly registry: AgentRegistry;
  private model: ModelSelection | null = null;
  private readonly liveMessages = new Map<string, Map<string, Message>>();
  private readonly pendingApprovals: () => ReadonlyArray<ToolApprovalRequest>;
  private readonly onChatChanged: (chat: Chat) => void;
  private readonly logger: Pick<StructuredLogger, "warn"> | undefined;

  constructor(
    repository: ConversationRepository,
    registry: AgentRegistry,
    pendingApprovals: () => ReadonlyArray<ToolApprovalRequest> = () => [],
    options: ConversationServiceOptions = {},
  ) {
    this.repository = repository;
    this.registry = registry;
    this.pendingApprovals = pendingApprovals;
    this.onChatChanged = options.onChatChanged ?? (() => undefined);
    this.logger = options.logger;
  }

  async start(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await this.repository.load();
    await this.registry.restore(this.repository.listAgentContexts(), model);
  }

  getState(): ConversationStateView {
    return {
      initialized: this.repository.isInitialized(),
      chats: this.withLiveMessages(this.repository.readChats()),
      statuses: this.registry.statuses(),
      agentEventSequence: this.registry.getEventSequence(),
      pendingToolApprovals: this.pendingApprovals(),
      recoveredCorruptState: this.repository.didRecoverCorruptState(),
    };
  }

  handleAgentEvent(event: SequencedConversationAgentEvent): void {
    if (event.type === "conversation_context_renewed") {
      this.persistLiveMessage(event.conversationId, {
        id: `context:${event.createdAt}`,
        type: "time",
        text: event.kind === "compacted" ? "Context summarized · History preserved" : "New topic · History preserved",
        createdAt: event.createdAt,
      });
      return;
    }
    if (event.type === "assistant_message_started") {
      this.persistOutgoingStatus(event.conversationId, event.requestId, "complete");
      this.setLiveMessage(event.conversationId, {
        id: event.messageId,
        type: "incoming",
        text: "",
        status: "streaming",
        createdAt: event.createdAt,
      });
      return;
    }
    if (event.type === "assistant_text_delta") {
      const current = this.getLiveMessage(event.conversationId, event.messageId);
      this.setLiveMessage(event.conversationId, {
        id: event.messageId,
        type: "incoming",
        text: `${current?.type === "incoming" ? current.text : ""}${event.delta}`,
        status: "streaming",
        ...(current?.createdAt ? { createdAt: current.createdAt } : {}),
      });
      return;
    }
    if (event.type === "assistant_message_completed" || event.type === "assistant_message_cancelled") {
      const current = this.getLiveMessage(event.conversationId, event.messageId);
      const message: Message & { id: string } = {
        id: event.messageId,
        type: "incoming",
        text: current?.type === "incoming" ? current.text : "",
        status: event.type === "assistant_message_completed" ? "complete" : "cancelled",
        ...(current?.createdAt ? { createdAt: current.createdAt } : {}),
      };
      this.persistLiveMessage(event.conversationId, message);
      return;
    }
    if (event.type === "conversation_error" && event.requestId) {
      this.persistOutgoingStatus(event.conversationId, event.requestId, "failed");
      const messageId = `${event.requestId}:assistant`;
      const current = this.getLiveMessage(event.conversationId, messageId);
      this.persistLiveMessage(event.conversationId, {
        id: messageId,
        type: "incoming",
        text: current?.type === "incoming" && current.text ? current.text : event.error.message,
        status: "failed",
        retryable: event.error.retryable,
        createdAt: current?.createdAt ?? event.createdAt,
      });
    }
  }

  async initialize(chats: unknown): Promise<ConversationStateView> {
    await this.repository.initialize(chats);
    await this.registry.restore(this.repository.listAgentContexts(), this.model);
    return this.getState();
  }

  async create(conversation: Chat, model?: ModelSelection | null): Promise<ConversationStateView> {
    await this.repository.create(conversation, model ?? null);
    if (conversation.kind === "wisp") {
      try {
        await this.registry.create(this.repository.getAgentContext(conversation.id));
      } catch (error) {
        await this.repository.delete(conversation.id).catch(() => undefined);
        throw error;
      }
    }
    return this.getState();
  }

  async update(conversationId: string, changes: ChatChanges): Promise<ConversationStateView> {
    await this.repository.update(conversationId, changes);
    if (
      changes.kind === "wisp" &&
      (changes.name !== undefined || changes.label !== undefined || changes.description !== undefined)
    ) {
      await this.registry.updateContext(this.repository.getAgentContext(conversationId));
    }
    return this.getState();
  }

  async appendMessage(conversationId: string, message: Message): Promise<Chat> {
    await this.repository.appendMessage(conversationId, message);
    return this.requireChatView(conversationId);
  }

  async answerPrompt(conversationId: string, messageId: string, answer: string): Promise<Chat> {
    await this.repository.answerPrompt(conversationId, messageId, answer);
    return this.requireChatView(conversationId);
  }

  async markRead(conversationId: string): Promise<Chat> {
    await this.repository.markRead(conversationId);
    return this.requireChatView(conversationId);
  }

  async delete(conversationId: string): Promise<ConversationStateView> {
    const conversation = this.repository.readChats()[conversationId];
    const context = conversation?.kind === "wisp" ? this.repository.getAgentContext(conversationId) : null;
    if (context) await this.registry.delete(conversationId);
    try {
      await this.repository.delete(conversationId);
      this.liveMessages.delete(conversationId);
    } catch (error) {
      if (context) await this.registry.create(context).catch(() => undefined);
      throw error;
    }
    return this.getState();
  }

  getConversationModel(conversationId: string): ConversationModelView {
    this.repository.getAgentContext(conversationId);
    return this.registry.getModelView(conversationId);
  }

  async applyConversationModel(conversationId: string, model: ModelSelection | null): Promise<void> {
    await this.repository.setModelOverride(conversationId, model);
    await this.registry.applyConversationModel(conversationId, model);
  }

  async applyModel(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await this.registry.applyModel(model);
  }

  async dispose(): Promise<void> {
    await this.registry.disposeAll();
  }

  private getLiveMessage(conversationId: string, messageId: string): Message | undefined {
    return this.liveMessages.get(conversationId)?.get(messageId);
  }

  private setLiveMessage(conversationId: string, message: Message & { id: string }): void {
    const messages = this.liveMessages.get(conversationId) ?? new Map<string, Message>();
    messages.set(message.id, message);
    this.liveMessages.set(conversationId, messages);
  }

  private persistLiveMessage(conversationId: string, message: Message & { id: string }): void {
    this.setLiveMessage(conversationId, message);
    void this.repository.appendMessage(conversationId, message).then(
      () => {
        const messages = this.liveMessages.get(conversationId);
        if (messages?.get(message.id) === message) {
          messages.delete(message.id);
          if (messages.size === 0) this.liveMessages.delete(conversationId);
        }
        this.publishChat(conversationId);
      },
      // The message stays live (visible) until restart, so say it will not survive one.
      (error) => this.reportPersistenceFailure(conversationId, message.id, error),
    );
  }

  private persistOutgoingStatus(conversationId: string, requestId: string, status: "complete" | "failed"): void {
    const message = this.repository.readChats()[conversationId]?.messages.find(({ id }) => id === requestId);
    if (message?.type !== "outgoing") return;
    void this.repository.appendMessage(conversationId, { ...message, id: requestId, status }).then(
      () => this.publishChat(conversationId),
      (error) => this.reportPersistenceFailure(conversationId, requestId, error),
    );
  }

  private publishChat(conversationId: string): void {
    const chat = this.chatView(conversationId);
    if (chat) this.onChatChanged(chat);
  }

  /** One stored chat with live messages overlaid, as the renderer should see it. */
  private chatView(conversationId: string): Chat | undefined {
    const chat = this.repository.readChat(conversationId);
    return chat ? this.withLiveMessages({ [conversationId]: chat })[conversationId] : undefined;
  }

  private requireChatView(conversationId: string): Chat {
    const chat = this.chatView(conversationId);
    if (!chat) throw new WispBackendError("not_found", "The conversation was not found.");
    return chat;
  }

  private reportPersistenceFailure(conversationId: string, messageId: string, error: unknown): void {
    const { code } = sanitizeBackendError(error);
    this.logger?.warn("conversation_persist_failed", { conversationId, messageId, code });
    // Deleted conversations are expected to drop their pending writes.
    if (!this.repository.readChats()[conversationId]) return;
    // No requestId: this reports the storage failure without re-entering the per-request persistence path.
    this.registry.publishExternalEvent({
      type: "conversation_error",
      conversationId,
      createdAt: new Date().toISOString(),
      error: {
        code: "internal_error",
        message: "A message could not be saved and will be missing after Wisp restarts.",
        retryable: false,
      },
    });
  }

  private withLiveMessages(chats: Readonly<ChatCollection>): ChatCollection {
    const result: ChatCollection = { ...chats };
    for (const [conversationId, live] of this.liveMessages) {
      const chat = chats[conversationId];
      if (!chat) continue;
      const storedIds = new Set(chat.messages.flatMap(({ id }) => (id ? [id] : [])));
      result[conversationId] = {
        ...chat,
        messages: [
          ...chat.messages.map((message) => (message.id && live.has(message.id) ? live.get(message.id)! : message)),
          ...[...live.values()].filter((message) => !message.id || !storedIds.has(message.id)),
        ],
      };
    }
    return result;
  }
}
