import type {
  BackendError,
  ConversationModelView,
  ModelSelection,
  SequencedConversationAgentEvent,
} from "../shared/contracts.js";
import {
  assistantMessageId,
  chatSummary,
  type Chat,
  type ChatChanges,
  type CircleChat,
  type ChatCollection,
  type ConversationDelta,
  type ConversationStateView,
  type Message,
  type MessagePage,
  type MessagePageRequest,
  type MessageSearchHit,
  type OutgoingMessage,
  type Wisp,
  type WispChanges,
} from "../shared/conversations.js";
import type { QueuedMessage } from "../shared/message-queue.js";
import type { ToolApprovalRequest } from "../shared/tool-policy.js";
import type { AgentRegistry } from "./agent-registry.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationRepository, MessageChange } from "./conversation-repository.js";
import type { StructuredLogger } from "./structured-logger.js";

export interface ConversationServiceOptions {
  /** Receives what changed after agent-driven changes are persisted, so the renderer never re-fetches anything. */
  onConversationChanged?: (delta: ConversationDelta) => void;
  logger?: Pick<StructuredLogger, "warn">;
  /** Called after conversations were deleted or replaced, which also removes their scheduled messages. */
  onConversationsRemoved?: () => void;
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
  private readonly onConversationChanged: (delta: ConversationDelta) => void;
  private readonly logger: Pick<StructuredLogger, "warn"> | undefined;
  private readonly onConversationsRemoved: () => void;

  constructor(
    repository: ConversationRepository,
    registry: AgentRegistry,
    pendingApprovals: () => ReadonlyArray<ToolApprovalRequest> = () => [],
    options: ConversationServiceOptions = {},
  ) {
    this.repository = repository;
    this.registry = registry;
    this.pendingApprovals = pendingApprovals;
    this.onConversationChanged = options.onConversationChanged ?? (() => undefined);
    this.logger = options.logger;
    this.onConversationsRemoved = options.onConversationsRemoved ?? (() => undefined);
  }

  async start(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await this.repository.load();
    this.failUnansweredRequests();
    await this.registry.restore(this.repository.listAgentContexts(), model);
  }

  getUserProfile() {
    return this.repository.getUserProfile();
  }

  async saveUserProfile(value: unknown) {
    const profile = await this.repository.saveUserProfile(value);
    await Promise.all(this.repository.listAgentContexts().map((context) => this.registry.updateContext(context)));
    return profile;
  }

  getState(): ConversationStateView {
    return {
      initialized: this.repository.isInitialized(),
      wisps: this.repository.readWisps(),
      chats: this.withLiveMessages(this.repository.readChats()),
      statuses: this.registry.statuses(),
      liveMessages: Object.fromEntries(
        [...this.liveMessages].map(([conversationId, messages]) => [conversationId, [...messages.values()]]),
      ),
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
        ...this.authorOf(event.conversationId),
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
        ...this.authorOf(event.conversationId),
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
        ...this.authorOf(event.conversationId),
      };
      this.persistLiveMessage(event.conversationId, message);
      return;
    }
    if (event.type === "conversation_error" && event.requestId) {
      this.persistRequestFailure(event.conversationId, event.requestId, event.error, event.messageId, event.createdAt);
    }
  }

  /**
   * Requests left without a reply when Wisp last stopped would show as queued
   * forever; they failed, and the person can retry them.
   */
  private failUnansweredRequests(): void {
    for (const { conversationId, messageId } of this.repository.listUnansweredRequests()) {
      this.persistRequestFailure(conversationId, messageId, {
        code: "aborted",
        message: "Wisp stopped before answering this message.",
        retryable: true,
      });
    }
  }

  /** Marks the person's message failed and adds the reply saying why. */
  private persistRequestFailure(
    conversationId: string,
    requestId: string,
    error: BackendError,
    replyId = assistantMessageId(requestId),
    createdAt = new Date().toISOString(),
  ): void {
    this.persistOutgoingStatus(conversationId, requestId, "failed");
    const current = this.getLiveMessage(conversationId, replyId);
    this.persistLiveMessage(conversationId, {
      id: replyId,
      type: "incoming",
      text: current?.type === "incoming" && current.text ? current.text : error.message,
      status: "failed",
      retryable: error.retryable,
      createdAt: current?.createdAt ?? createdAt,
      ...this.authorOf(conversationId),
    });
  }

  /** Replies in a Wisp's own conversation are the Wisp's. */
  private authorOf(conversationId: string): { authorId?: string } {
    const chat = this.repository.readChat(conversationId);
    return chat?.kind === "wisp" ? { authorId: chat.wispId } : {};
  }

  async initialize(chats: unknown): Promise<ConversationStateView> {
    await this.repository.initialize(chats);
    this.onConversationsRemoved();
    await this.registry.restore(this.repository.listAgentContexts(), this.model);
    return this.getState();
  }

  /** Creates a Wisp with its own conversation and starts its agent there. */
  async createWisp(
    wisp: Wisp,
    options: { notifyOnUpdatesEnabled: boolean; model?: ModelSelection | null },
  ): Promise<ConversationStateView> {
    await this.repository.createWisp(wisp, {
      notifyOnUpdatesEnabled: options.notifyOnUpdatesEnabled,
      modelOverride: options.model ?? null,
    });
    try {
      await this.registry.create(this.repository.getAgentContext(wisp.id));
    } catch (error) {
      await this.repository.deleteWisp(wisp.id).catch(() => undefined);
      throw error;
    }
    return this.getState();
  }

  async updateWisp(wispId: string, changes: WispChanges): Promise<ConversationStateView> {
    await this.repository.updateWisp(wispId, changes);
    if (changes.name !== undefined || changes.role !== undefined || changes.soul !== undefined) {
      await this.registry.updateContext(this.repository.getAgentContext(wispId));
    }
    return this.getState();
  }

  /** Deletes a Wisp, its own conversation, and its place in circles. */
  async deleteWisp(wispId: string): Promise<ConversationStateView> {
    const context = this.repository.readConversationWisp(wispId) ? this.repository.getAgentContext(wispId) : null;
    if (!context) throw new WispBackendError("not_found", "The Wisp was not found.");
    await this.registry.delete(wispId);
    try {
      await this.repository.deleteWisp(wispId);
      this.liveMessages.delete(wispId);
    } catch (error) {
      await this.registry.create(context).catch(() => undefined);
      throw error;
    }
    this.onConversationsRemoved();
    return this.getState();
  }

  /** Creates a circle; a Wisp's own conversation is created with the Wisp. */
  async create(conversation: CircleChat): Promise<ConversationStateView> {
    await this.repository.create(conversation);
    return this.getState();
  }

  async update(conversationId: string, changes: ChatChanges): Promise<ConversationStateView> {
    await this.repository.update(conversationId, changes);
    return this.getState();
  }

  /** Saves a message the user wrote. It may update the user's own message, never a reply or notice. */
  async appendMessage(conversationId: string, message: OutgoingMessage): Promise<ConversationDelta> {
    const change = await this.repository.appendOutgoingMessage(conversationId, message);
    return this.requireDelta(conversationId, changesOf(change));
  }

  /**
   * Hands a Wisp its oldest queued message: moved into the transcript (with
   * status queued until the reply starts), then sent. Calls `onTaken` once it
   * has left the queue, and resolves with it after the request has finished,
   * or with undefined when nothing was waiting. A Wisp that cannot take it
   * marks it failed, so it can be retried from the transcript.
   */
  async deliverNextQueued(conversationId: string, onTaken: () => void): Promise<QueuedMessage | undefined> {
    const taken = await this.repository.takeQueuedMessage(conversationId, (queued) => ({
      id: queued.id,
      type: "outgoing",
      text: queued.text,
      createdAt: new Date().toISOString(),
      status: "queued",
      ...(queued.scheduled ? { scheduled: queued.scheduled } : {}),
    }));
    if (!taken) return undefined;
    const { queued } = taken;
    this.publish(conversationId, changesOf(taken.change));
    onTaken();
    const request = {
      conversationId,
      requestId: queued.id,
      text: queued.text,
      ...(queued.scheduled ? { scheduled: queued.scheduled } : {}),
    };
    try {
      await this.registry.dispatch(request);
    } catch (error) {
      this.persistRequestFailure(conversationId, queued.id, sanitizeBackendError(error));
    }
    return queued;
  }

  /**
   * One page of a transcript. Replies still streaming are overlaid by ID, and
   * those not yet stored are added to a page that reaches the newest message.
   */
  async getMessagePage(request: MessagePageRequest): Promise<MessagePage> {
    const page = await this.repository.getMessagePage(request);
    const live = this.liveMessages.get(request.conversationId);
    if (!live) return page;
    const pageIds = new Set(page.messages.flatMap(({ id }) => (id ? [id] : [])));
    const messages = page.messages.map((message) => (message.id && live.get(message.id)) || message);
    if (page.newerCursor === null) {
      for (const message of live.values()) {
        if (!message.id || pageIds.has(message.id)) continue;
        if (!(await this.repository.getMessage(request.conversationId, message.id))) messages.push(message);
      }
    }
    return { ...page, messages };
  }

  searchMessages(query: string): Promise<ReadonlyArray<MessageSearchHit>> {
    return this.repository.searchMessages(query);
  }

  async answerPrompt(conversationId: string, messageId: string, answer: string): Promise<ConversationDelta> {
    const prompt = await this.repository.answerPrompt(conversationId, messageId, answer);
    return this.requireDelta(conversationId, { updated: [prompt] });
  }

  async markRead(conversationId: string): Promise<ConversationDelta> {
    await this.repository.markRead(conversationId);
    return this.requireDelta(conversationId, {});
  }

  /** Deletes a circle; a Wisp's own conversation goes only with the Wisp. */
  async delete(conversationId: string): Promise<ConversationStateView> {
    await this.repository.delete(conversationId);
    this.liveMessages.delete(conversationId);
    this.onConversationsRemoved();
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
      (change) => {
        const messages = this.liveMessages.get(conversationId);
        if (messages?.get(message.id) === message) {
          messages.delete(message.id);
          if (messages.size === 0) this.liveMessages.delete(conversationId);
        }
        this.publish(conversationId, changesOf(change));
      },
      // The message stays live (visible) until restart, so say it will not survive one.
      (error) => this.reportPersistenceFailure(conversationId, message.id, error),
    );
  }

  private persistOutgoingStatus(conversationId: string, requestId: string, status: "complete" | "failed"): void {
    void this.repository.setOutgoingStatus(conversationId, requestId, status).then(
      (outgoing) => {
        if (outgoing) this.publish(conversationId, { updated: [outgoing] });
      },
      (error) => this.reportPersistenceFailure(conversationId, requestId, error),
    );
  }

  private publish(conversationId: string, changes: MessageChanges): void {
    const chat = this.repository.readChat(conversationId);
    if (chat) this.onConversationChanged(deltaOf(chat, changes));
  }

  private requireDelta(conversationId: string, changes: MessageChanges): ConversationDelta {
    const chat = this.repository.readChat(conversationId);
    if (!chat) throw new WispBackendError("not_found", "The conversation was not found.");
    return deltaOf(chat, changes);
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

type MessageChanges = Partial<Pick<ConversationDelta, "added" | "updated">>;

function changesOf({ message, added }: MessageChange): MessageChanges {
  return added ? { added: [message] } : { updated: [message] };
}

function deltaOf(chat: Readonly<Chat>, changes: MessageChanges): ConversationDelta {
  return { chat: chatSummary(chat), added: changes.added ?? [], updated: changes.updated ?? [] };
}
