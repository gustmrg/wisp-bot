import type { ModelSelection } from "../../shared/contracts.js";
import type {
  AgentSettings,
  Chat,
  ConversationStateView,
  Message,
} from "../../shared/conversations.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ConversationRepository } from "./conversation-repository.js";

export class ConversationService {
  private readonly repository: ConversationRepository;
  private readonly registry: AgentRegistry;
  private model: ModelSelection | null = null;

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
      chats: this.repository.getChats(),
      statuses: this.registry.statuses(),
      recoveredCorruptState: this.repository.didRecoverCorruptState(),
    };
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
}
