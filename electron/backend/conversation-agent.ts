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
  clearModel(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: ConversationAgentListener): () => void;
}

export interface ConversationAgentContext {
  conversationId: string;
  sessionId: string;
  name: string;
  label: string;
  description: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  configDirectory: string;
  piSessionId: string | null;
  piSessionFile: string | null;
  savePiSessionIdentity?: (identity: { sessionId: string; sessionFile: string | null }) => Promise<void>;
}

export interface ConversationAgentFactory {
  create(context: ConversationAgentContext): ConversationAgent;
}
