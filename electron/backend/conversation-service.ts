import type { ModelSelection, SequencedConversationAgentEvent } from "../../shared/contracts.js";
import type {
  AgentSettings,
  Chat,
  ChatCollection,
  ConversationStateView,
  Message,
} from "../../shared/conversations.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ConversationRepository } from "./conversation-repository.js";

export class ConversationService {
  private readonly repository: ConversationRepository;
  private readonly registry: AgentRegistry;
  private model: ModelSelection | null = null;
  private readonly liveMessages = new Map<string, Map<string, Message>>();

  constructor(repository: ConversationRepository, registry: AgentRegistry) {
    this.repository = repository;
    this.registry = registry;
  }

  async start(model: ModelSelection | null): Promise<void> {
    this.model = model;
    await this.repository.load();
    await this.registry.restore(this.repository.listAgentContexts(), model);
  }

  getState(): ConversationStateView {
    return {
      initialized: this.repository.isInitialized(),
      chats: this.withLiveMessages(this.repository.getChats()),
      statuses: this.registry.statuses(),
      agentEventSequence: this.registry.getEventSequence(),
      recoveredCorruptState: this.repository.didRecoverCorruptState(),
    };
  }

  handleAgentEvent(event: SequencedConversationAgentEvent): void {
    if (event.type === "assistant_message_started") {
      this.persistOutgoingStatus(event.conversationId, event.requestId, "complete");
      this.setLiveMessage(event.conversationId, {
        id: event.messageId,
        type: "incoming",
        text: "",
        status: "streaming",
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
      });
      return;
    }
    if (event.type === "assistant_message_completed" || event.type === "assistant_message_cancelled") {
      const current = this.getLiveMessage(event.conversationId, event.messageId);
      const message: Message & { id: string } = {
        id: event.messageId,
        type: "incoming",
        text: current?.type === "incoming" && current.text
          ? current.text
          : event.type === "assistant_message_cancelled" ? "Stopped." : "",
        status: event.type === "assistant_message_completed" ? "complete" : "cancelled",
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
      });
    }
  }

  async initialize(chats: unknown): Promise<ConversationStateView> {
    await this.repository.initialize(chats);
    await this.registry.restore(this.repository.listAgentContexts(), this.model);
    return this.getState();
  }

  async create(conversation: Chat): Promise<ConversationStateView> {
    await this.repository.create(conversation);
    if (!conversation.isCircle) {
      try {
        await this.registry.create(this.repository.getAgentContext(conversation.id));
      } catch (error) {
        await this.repository.delete(conversation.id).catch(() => undefined);
        throw error;
      }
    }
    return this.getState();
  }

  async update(
    conversationId: string,
    changes: Partial<Omit<AgentSettings, "id" | "isCircle">>,
  ): Promise<ConversationStateView> {
    await this.repository.update(conversationId, changes);
    return this.getState();
  }

  async appendMessage(conversationId: string, message: Message): Promise<ConversationStateView> {
    await this.repository.appendMessage(conversationId, message);
    return this.getState();
  }

  async answerPrompt(conversationId: string, messageId: string, answer: string): Promise<ConversationStateView> {
    await this.repository.answerPrompt(conversationId, messageId, answer);
    return this.getState();
  }

  async markRead(conversationId: string): Promise<ConversationStateView> {
    await this.repository.markRead(conversationId);
    return this.getState();
  }

  async delete(conversationId: string): Promise<ConversationStateView> {
    const conversation = this.repository.getChats()[conversationId];
    const context = conversation && !conversation.isCircle
      ? this.repository.getAgentContext(conversationId)
      : null;
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
    void this.repository.appendMessage(conversationId, message).then(() => {
      const messages = this.liveMessages.get(conversationId);
      if (messages?.get(message.id) !== message) return;
      messages.delete(message.id);
      if (messages.size === 0) this.liveMessages.delete(conversationId);
    }).catch(() => undefined);
  }

  private persistOutgoingStatus(
    conversationId: string,
    requestId: string,
    status: "complete" | "failed",
  ): void {
    const message = this.repository.getChats()[conversationId]?.messages.find(({ id }) => id === requestId);
    if (message?.type !== "outgoing") return;
    void this.repository.appendMessage(conversationId, { ...message, id: requestId, status }).catch(() => undefined);
  }

  private withLiveMessages(chats: ChatCollection): ChatCollection {
    for (const [conversationId, live] of this.liveMessages) {
      const chat = chats[conversationId];
      if (!chat) continue;
      const liveIds = new Set(live.keys());
      chats[conversationId] = {
        ...chat,
        messages: [
          ...chat.messages.map((message) => message.id && liveIds.has(message.id)
            ? live.get(message.id)!
            : message),
          ...[...live.values()].filter((message) => !chat.messages.some(({ id }) => id === message.id)),
        ],
      };
    }
    return chats;
  }
}
