import type { ContextCommand, ContextView } from "../shared/context-policy.js";
import type { ConversationAgentEvent, ModelSelection, SendMessageRequest, WispFallback } from "../shared/contracts.js";

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
  updateContext(context: AgentContext): Promise<void>;
  applyModel(model: ModelSelection): Promise<void>;
  clearModel(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: ConversationAgentListener): () => void;
  /**
   * Adds what one of the Wisp's jobs delivered to its context, without
   * starting a turn, so the person can follow up on it (ADR 019).
   */
  rememberJobResult?(text: string): Promise<void>;
  /**
   * Hands a follow-up to the turn running now, which reads it before its next
   * model call and answers it as `request.requestId` from then on (it emits
   * `follow_up_taken`). Resolves false when no turn can take it, so it waits
   * for the next turn instead.
   */
  steer?(request: SendMessageRequest): Promise<boolean>;
  /** Takes back the follow-ups handed to the running turn that it has not read, oldest first. */
  withdrawFollowUps?(): string[];
  /**
   * Applies the app's model to an agent whose members each answer with their
   * own, a circle's (ADR 011), in place of `applyModel` and `clearModel`.
   * Resolves whether any member can answer.
   */
  applyAppModel?(model: ModelSelection | null): Promise<boolean>;
}

/** The circle a Wisp's agent answers in, as its system prompt describes it (ADR 011). */
export interface CircleSetting {
  name: string;
  description: string;
  /** Every member in order, the lead first and the Wisp itself among them. */
  members: ReadonlyArray<{ id: string; name: string; role: string }>;
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
  /** The Wisp's saved fallback choice; null until it chooses, when it follows its model. */
  fallback?: WispFallback | null;
  /** The conversation's workspace. */
  workspaceDirectory: string;
  /** The Wisp's session in this conversation. */
  sessionDirectory: string;
  /** The Wisp's own settings, skills, and saved memory, the same in every conversation. */
  configDirectory: string;
  /** Where the conversation's workspace size is kept: the circle's in a circle; unset, `configDirectory`. */
  workspaceSettingsDirectory?: string;
  piSessionId: string | null;
  piSessionFile: string | null;
  onContextRenewed?: (kind: "compacted" | "new_topic", createdAt: string) => void;
  savePiSessionIdentity?: (identity: { sessionId: string; sessionFile: string | null }) => Promise<void>;
  /** Set when the Wisp answers in a circle rather than in its own conversation. */
  circle?: CircleSetting;
}

/** A circle's agent: one agent per member, which answer one turn at a time (ADR 011). */
export interface CircleAgentContext {
  kind: "circle";
  conversationId: string;
  /** Each member's context in the circle, in member order: the lead first. */
  members: ReadonlyArray<ConversationAgentContext>;
  /** The person's preferred name, which labels their messages to the members. */
  userName?: string;
}

/** What the registry starts an agent from: a Wisp in its own conversation, or a circle. */
export type AgentContext = ConversationAgentContext | CircleAgentContext;

export function isCircleContext(context: AgentContext): context is CircleAgentContext {
  return "kind" in context && context.kind === "circle";
}

export interface ConversationAgentFactory<Context extends AgentContext = ConversationAgentContext> {
  create(context: Context): ConversationAgent;
}
