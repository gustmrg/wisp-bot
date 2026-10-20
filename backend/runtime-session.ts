/**
 * The session a Wisp's conversation agent works through, whatever runtime
 * runs it: Pi, or Claude Code shaped as a Pi session (ADR 026).
 */

import type { ContextCommand, ContextView } from "../shared/context-policy.js";
import type { ModelSelection, SessionReportUsage, ThinkingLevel } from "../shared/contracts.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import type { ModelRuntimeLike } from "./model-service.js";
import type { PiAgentEvent } from "./pi-event-translator.js";

/** A catalog model, as a session factory resolves a selection to it. */
export type RuntimeModel = NonNullable<ReturnType<ModelRuntimeLike["getModel"]>>;

export interface RuntimeSession {
  readonly isIdle: boolean;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  /** Snapshot revision the session's tool registry was built from. */
  readonly toolRevision: string;
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
  manageContext?(command: ContextCommand): Promise<ContextView>;
  /** Must not start the model run once `signal` is aborted. */
  prompt(text: string, options?: { expandPromptTemplates?: boolean; signal?: AbortSignal }): Promise<void>;
  /** Adds a message, verbatim, that the running turn reads before its next model call. */
  steer?(text: string): void;
  /** Drops the messages handed to the running turn that it has not read. */
  clearQueue?(): void;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
  setModel(model: RuntimeModel, options?: { persist?: boolean }): Promise<void>;
  /** Pi clamps the level to what the current model supports. */
  setThinkingLevel(level: ThinkingLevel): void;
  getActiveToolNames(): string[];
  /** Adds a message to the model's context without starting a turn; not shown in the session's own UI. */
  appendCustomMessage?(customType: string, text: string): Promise<void>;
  dispose(): void;
}

/** The custom message type a job's delivered result has in the conversation's session. */
export const JOB_RESULT_MESSAGE = "wisp:job-result";

export interface RuntimeSessionFactory {
  resolveModel(selection: ModelSelection): RuntimeModel;
  create(context: ConversationAgentContext, selection: ModelSelection): Promise<RuntimeSession>;
  /** Current integration tool snapshot revision for this Wisp, or null. */
  getToolRevision(conversationId: string): Promise<string | null>;
  /**
   * Whether one session can switch between two selections' models. When it
   * cannot, as between Pi and Claude Code (ADR 026), the session closes and
   * the next message opens one for the new model. Missing means always.
   */
  sameRuntime?(current: ModelSelection, next: ModelSelection): boolean;
}

/** A job run's own session: no conversation history, and it never becomes the conversation's session. */
export interface RuntimeJobSession {
  readonly sessionFile: string | undefined;
  /** The names of the tools the run is offered. */
  getActiveToolNames(): string[];
  prompt(text: string, signal: AbortSignal): Promise<void>;
  /** The run's last assistant message, if the model answered. */
  lastAssistantMessage(): { text: string; stopReason?: string; errorMessage?: string } | undefined;
  usage(): SessionReportUsage;
  dispose(): void;
}
