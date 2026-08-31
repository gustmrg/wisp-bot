import type {
  ConversationAgentEvent,
  ModelSelection,
  SendMessageRequest,
} from "../../shared/contracts.js";

export type ConversationAgentListener = (event: ConversationAgentEvent) => void;

export interface ConversationAgent {
  start(): Promise<void>;
  send(request: SendMessageRequest): Promise<void>;
  abort(): Promise<void>;
  applyModel(model: ModelSelection): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: ConversationAgentListener): () => void;
}

export interface ConversationAgentContext {
  conversationId: string;
  sessionId: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  configDirectory: string;
}

export interface ConversationAgentFactory {
  create(context: ConversationAgentContext): ConversationAgent;
}
