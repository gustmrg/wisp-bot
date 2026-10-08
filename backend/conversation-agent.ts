import type { ContextCommand, ContextView } from "../shared/context-policy.js";
import type { ConversationAgentEvent, ModelSelection, SendMessageRequest } from "../shared/contracts.js";

export type ConversationAgentListener = (event: ConversationAgentEvent) => void;

export function normalizeUserName(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
}

export interface ConversationAgent {
  manageContext?(command: ContextCommand): Promise<ContextView>;
  start(): Promise<void>;
  send(request: SendMessageRequest): Promise<void>;
  abort(): Promise<void>;
  updateContext(context: ConversationAgentContext): Promise<void>;
  applyModel(model: ModelSelection): Promise<void>;
  clearModel(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: ConversationAgentListener): () => void;
}

/** One Wisp's agent in one conversation: who the Wisp is, and where its files and session live. */
export interface ConversationAgentContext {
  conversationId: string;
  wispId: string;
  /** Names the directory of the Wisp's session in this conversation. */
  sessionId: string;
  name: string;
  role: string;
  /** Markdown that defines the Wisp's identity, personality, and behavior. */
  soul: string;
  userName?: string;
  userProfile?: import("../shared/user-profile.js").UserProfile;
  /** The person's current time zone, read on every message; without it the Wisp is not told the time. */
  userTimeZone?: () => string;
  modelOverride?: ModelSelection | null;
  /** The conversation's workspace. */
  workspaceDirectory: string;
  /** The Wisp's session in this conversation. */
  sessionDirectory: string;
  /** The Wisp's own settings, skills, and saved memory, the same in every conversation. */
  configDirectory: string;
  piSessionId: string | null;
  piSessionFile: string | null;
  onContextRenewed?: (kind: "compacted" | "new_topic", createdAt: string) => void;
  savePiSessionIdentity?: (identity: { sessionId: string; sessionFile: string | null }) => Promise<void>;
}

export interface ConversationAgentFactory {
  create(context: ConversationAgentContext): ConversationAgent;
}
