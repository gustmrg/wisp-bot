import type { ConversationAgentEvent, ModelSelection, SendMessageRequest } from "../../shared/contracts.js";

export type ConversationAgentListener = (event: ConversationAgentEvent) => void;

export function normalizeUserName(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}

export interface ConversationAgent {
  start(): Promise<void>;
  send(request: SendMessageRequest): Promise<void>;
  abort(): Promise<void>;
  updateContext(context: ConversationAgentContext): Promise<void>;
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
  userName?: string;
  modelOverride?: ModelSelection | null;
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
