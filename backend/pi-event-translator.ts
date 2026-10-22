import type { BackendError, ConversationAgentEvent, SendMessageRequest, ToolStepDetail } from "../shared/contracts.js";
import { assistantMessageId, MESSAGE_REASONING_MAX_LENGTH } from "../shared/conversations.js";
import { describeProviderError, isRetryableProviderError } from "./provider-error.js";
import { getToolMetadata } from "../shared/tool-catalog.js";
import type { WispDisplay } from "./conversation-agent.js";
import {
  isCommandTool,
  toolStepDetail,
  toolStepResult,
  verboseStepCommand,
  verboseStepOutput,
} from "./tool-step-detail.js";

const MAX_DELTA_CHARACTERS = 8_000;
const MAX_RESPONSE_CHARACTERS = 500_000;
const MAX_ERROR_CHARACTERS = 2_000;
const GENERIC_ERROR_MESSAGE = "The model request failed.";

export interface PiAssistantMessageSnapshot {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

const MAX_ACTIVITY_LABEL_CHARACTERS = 160;

/** A tool's own progress text from its partial result, bounded and stripped of control characters. */
function activityLabelOf(partialResult: unknown): string | undefined {
  const label = (partialResult as { details?: { activityLabel?: unknown } } | undefined)?.details?.activityLabel;
  if (typeof label !== "string") return undefined;
  const clean = label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return clean ? clean.slice(0, MAX_ACTIVITY_LABEL_CHARACTERS) : undefined;
}

export function sanitizeErrorMessage(value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= MAX_ERROR_CHARACTERS) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_CHARACTERS)}…`;
}

export type PiAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "agent_settled" }
  | {
      type: "message_update";
      assistantMessageEvent: {
        type: string;
        delta?: string;
        reason?: string;
        error?: PiAssistantMessageSnapshot;
      };
    }
  | { type: "message_start"; message?: { role?: string } }
  | { type: "message_end"; message?: PiAssistantMessageSnapshot }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean; result?: unknown }
  | { type: "auto_retry_start"; errorMessage?: string }
  | { type: "auto_retry_end"; success?: boolean; finalError?: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  /** Wisp's own: the turn moved to the fallback model, named here. */
  | { type: "model_fallback"; model: string };

type EventPublisher = (event: ConversationAgentEvent) => void;

export class PiEventTranslator {
  private readonly conversationId: string;
  private readonly publish: EventPublisher;
  private readonly flushDelayMs: number;
  /** Where the Wisp's file tools work, so the paths steps show are relative to it. */
  private readonly workspaceDirectory: string;
  private request: SendMessageRequest | null = null;
  private messageId = "";
  private messagePart = 1;
  private messageStarted = false;
  /** Whether the current message has visible text, so a tool call only splits a message the user can see. */
  private messageHasText = false;
  private pendingDelta = "";
  private pendingReasoning = "";
  /** What reaches the chat beyond replies and step summaries: reasoning, and verbose steps (ADR 029). */
  private display: WispDisplay = { showReasoning: false, verboseSteps: false };
  /** Reasoning sent for the current message, bounded like the message keeps it. */
  private reasoningCharacters = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private failed = false;
  private cancelled = false;
  private responseCharacters = 0;
  private lastErrorMessage = "";
  private retryNoticeVisible = false;
  /** The fallback model answering the rest of the turn, if the Wisp's own failed. */
  private fallbackModel: string | undefined;

  constructor(conversationId: string, publish: EventPublisher, flushDelayMs = 24, workspaceDirectory = "") {
    this.conversationId = conversationId;
    this.publish = publish;
    this.flushDelayMs = flushDelayMs;
    this.workspaceDirectory = workspaceDirectory;
  }

  begin(request: SendMessageRequest): void {
    this.clearTimer();
    this.request = request;
    this.messagePart = 1;
    this.messageId = assistantMessageId(request.requestId);
    this.messageStarted = false;
    this.messageHasText = false;
    this.pendingDelta = "";
    this.pendingReasoning = "";
    this.reasoningCharacters = 0;
    this.failed = false;
    this.cancelled = false;
    this.responseCharacters = 0;
    this.lastErrorMessage = "";
    this.retryNoticeVisible = false;
    this.fallbackModel = undefined;
  }

  /** Applies the Wisp's display choices from its next event on, so a change reaches a running turn. */
  setDisplay(display: WispDisplay): void {
    this.display = display;
    if (!display.showReasoning) this.pendingReasoning = "";
  }

  handle(event: PiAgentEvent): void {
    const request = this.request;
    if (!request) return;

    switch (event.type) {
      case "agent_start":
        this.publish({ type: "conversation_status", conversationId: this.conversationId, status: "working" });
        this.startMessage();
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" && typeof update.delta === "string") {
          this.lastErrorMessage = "";
          this.startMessage();
          this.queueDelta(update.delta);
        } else if (update.type === "thinking_delta" && typeof update.delta === "string") {
          this.queueReasoning(update.delta);
        } else if (update.type === "error") {
          if (update.reason === "aborted") this.cancelled = true;
          else
            this.captureError(update.error ?? { role: "assistant", stopReason: "error", errorMessage: update.reason });
        }
        break;
      }
      case "message_end":
        this.captureError(event.message);
        break;
      case "tool_execution_start":
        this.completeMessagePart();
        this.publishTool(event, "started", undefined, undefined, this.startDetail(event.toolName, event.args));
        break;
      case "tool_execution_update":
        this.publishTool(event, "updated", undefined, activityLabelOf(event.partialResult));
        break;
      case "tool_execution_end":
        this.publishTool(event, "completed", event.isError, undefined, this.endDetail(event));
        break;
      case "auto_retry_start":
        this.retryNoticeVisible = !event.errorMessage || isRetryableProviderError(event.errorMessage);
        if (this.retryNoticeVisible) this.publishNotice("retry_started");
        break;
      case "auto_retry_end":
        if (event.success === false && event.finalError) {
          this.captureError({ role: "assistant", stopReason: "error", errorMessage: event.finalError });
        }
        if (this.retryNoticeVisible) this.publishNotice("retry_finished");
        this.retryNoticeVisible = false;
        break;
      case "compaction_start":
        this.publishNotice("compaction_started");
        break;
      case "model_fallback":
        // The Wisp's own model failed before answering; its error is not this turn's.
        this.fallbackModel = event.model;
        this.lastErrorMessage = "";
        this.publishNotice("fallback_started");
        break;
      case "compaction_end":
        this.publishNotice("compaction_finished");
        break;
      case "agent_settled":
        this.finish();
        break;
    }
  }

  /**
   * Ends the reply to the current request where the turn read a follow-up,
   * and answers the follow-up with the rest of the turn.
   */
  takeFollowUp(followUp: SendMessageRequest): void {
    const request = this.request;
    if (!request || this.failed || this.cancelled) return;
    this.flush();
    // A part without text is hidden in the transcript, so closing it leaves nothing behind.
    if (this.messageStarted) {
      this.publish({
        type: "assistant_message_completed",
        conversationId: this.conversationId,
        requestId: request.requestId,
        messageId: this.messageId,
        ...this.fallbackField(),
      });
    }
    this.publish({
      type: "follow_up_taken",
      conversationId: this.conversationId,
      requestId: request.requestId,
      followUpId: followUp.requestId,
    });
    this.request = followUp;
    this.messagePart = 1;
    this.messageId = assistantMessageId(followUp.requestId);
    this.messageStarted = false;
    this.messageHasText = false;
    this.reasoningCharacters = 0;
    this.responseCharacters = 0;
    this.lastErrorMessage = "";
    this.startMessage();
  }

  markCancelled(): void {
    if (this.request) this.cancelled = true;
  }

  reportError(error: BackendError): void {
    if (!this.request || this.failed) return;
    this.failed = true;
    this.flush();
    this.publish({
      type: "conversation_error",
      conversationId: this.conversationId,
      requestId: this.request.requestId,
      messageId: this.messageId,
      createdAt: new Date().toISOString(),
      error,
    });
  }

  finish(): void {
    if (!this.request) return;
    const request = this.request;
    this.flush();
    if (this.cancelled) {
      this.startMessage();
      this.publish({
        type: "assistant_message_cancelled",
        conversationId: this.conversationId,
        requestId: request.requestId,
        messageId: this.messageId,
      });
    } else if (this.failed) {
    } else if (this.lastErrorMessage) {
      const described = describeProviderError(this.lastErrorMessage);
      this.reportError({
        code: "internal_error",
        message: described.message,
        retryable: described.retryable,
        detail: this.lastErrorMessage,
      });
    } else if (this.responseCharacters === 0) {
      this.reportError({ code: "internal_error", message: GENERIC_ERROR_MESSAGE, retryable: true });
    } else if (this.messagePart > 1 && !this.messageStarted) {
      // The reply ended right after a tool call: its earlier parts are already complete.
    } else {
      this.startMessage();
      this.publish({
        type: "assistant_message_completed",
        conversationId: this.conversationId,
        requestId: request.requestId,
        messageId: this.messageId,
        ...this.fallbackField(),
      });
    }
    this.publish({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
    this.request = null;
  }

  dispose(): void {
    this.clearTimer();
    this.request = null;
    this.pendingDelta = "";
    this.pendingReasoning = "";
  }

  private startMessage(): void {
    if (this.messageStarted || !this.request) return;
    this.messageStarted = true;
    this.publish({
      type: "assistant_message_started",
      conversationId: this.conversationId,
      requestId: this.request.requestId,
      messageId: this.messageId,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Ends the current message before a tool runs, so text written before the
   * tool call ("Let me look that up") stands as its own message. The next text
   * starts a new message. A message without text stays open.
   */
  private completeMessagePart(): void {
    if (!this.request || this.failed || this.cancelled) return;
    this.flush();
    if (!this.messageStarted || !this.messageHasText) return;
    this.publish({
      type: "assistant_message_completed",
      conversationId: this.conversationId,
      requestId: this.request.requestId,
      messageId: this.messageId,
      ...this.fallbackField(),
    });
    this.messagePart += 1;
    this.messageId = assistantMessageId(this.request.requestId, this.messagePart);
    this.messageStarted = false;
    this.messageHasText = false;
    this.reasoningCharacters = 0;
  }

  private captureError(message: PiAssistantMessageSnapshot | undefined): void {
    if (!message || message.role !== "assistant") return;
    if (message.stopReason === "error") {
      const detail = sanitizeErrorMessage(message.errorMessage);
      if (detail) this.lastErrorMessage = detail;
      return;
    }
    if (message.stopReason && message.stopReason !== "error") this.lastErrorMessage = "";
  }

  private queueDelta(delta: string): void {
    if (!delta || this.failed) return;
    const remaining = MAX_RESPONSE_CHARACTERS - this.responseCharacters;
    if (remaining <= 0) {
      this.reportError({
        code: "internal_error",
        message: "The model response exceeded the supported size.",
        retryable: false,
      });
      return;
    }
    const accepted = delta.slice(0, remaining);
    this.responseCharacters += accepted.length;
    for (let offset = 0; offset < accepted.length; offset += MAX_DELTA_CHARACTERS) {
      this.pendingDelta += accepted.slice(offset, offset + MAX_DELTA_CHARACTERS);
      if (this.pendingDelta.length >= MAX_DELTA_CHARACTERS) this.flush();
    }
    if (accepted.length < delta.length) {
      this.reportError({
        code: "internal_error",
        message: "The model response exceeded the supported size.",
        retryable: false,
      });
      return;
    }
    if (this.flushDelayMs <= 0) {
      this.flush();
      return;
    }
    this.flushTimer ??= setTimeout(() => this.flush(), this.flushDelayMs);
  }

  /**
   * Reasoning goes with the message whose text follows it. It never counts as
   * a response, and past the bound a message keeps, the rest is dropped.
   */
  private queueReasoning(delta: string): void {
    if (!this.display.showReasoning || !delta || this.failed || this.cancelled) return;
    const accepted = delta.slice(0, MESSAGE_REASONING_MAX_LENGTH - this.reasoningCharacters);
    if (!accepted) return;
    this.reasoningCharacters += accepted.length;
    this.startMessage();
    this.pendingReasoning += accepted;
    if (this.flushDelayMs <= 0 || this.pendingReasoning.length >= MAX_DELTA_CHARACTERS) {
      this.flush();
      return;
    }
    this.flushTimer ??= setTimeout(() => this.flush(), this.flushDelayMs);
  }

  private flush(): void {
    this.clearTimer();
    if (this.request && this.pendingReasoning) {
      const reasoning = this.pendingReasoning;
      this.pendingReasoning = "";
      this.publish({
        type: "assistant_reasoning_delta",
        conversationId: this.conversationId,
        requestId: this.request.requestId,
        messageId: this.messageId,
        delta: reasoning,
      });
    }
    if (!this.request || !this.pendingDelta) return;
    const delta = this.pendingDelta;
    this.pendingDelta = "";
    if (delta.trim()) this.messageHasText = true;
    this.publish({
      type: "assistant_text_delta",
      conversationId: this.conversationId,
      requestId: this.request.requestId,
      messageId: this.messageId,
      delta,
    });
  }

  private publishTool(
    event: { toolCallId: string; toolName: string },
    phase: "started" | "updated" | "completed",
    isError?: boolean,
    label?: string,
    detail?: ToolStepDetail,
  ): void {
    if (!this.request || !getToolMetadata(event.toolName)) return;
    this.flush();
    this.publish({
      type: "tool_activity",
      conversationId: this.conversationId,
      requestId: this.request.requestId,
      toolCallId: safeId(event.toolCallId),
      toolName: event.toolName,
      phase,
      ...(phase === "completed" ? { isError: Boolean(isError) } : {}),
      ...(label ? { label } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  /** What a step works on; with verbose steps, a command as written too. */
  private startDetail(toolName: string, args: unknown): ToolStepDetail | undefined {
    const detail = toolStepDetail(toolName, args, this.workspaceDirectory);
    const command = this.display.verboseSteps ? verboseStepCommand(toolName, args) : undefined;
    return command ? { ...detail, command } : detail;
  }

  /** How a command ended; with verbose steps, the end of a command's output or a failed step's error too. */
  private endDetail(event: { toolName: string; isError: boolean; result?: unknown }): ToolStepDetail | undefined {
    const detail = toolStepResult(event.toolName, event.result);
    const output =
      this.display.verboseSteps && (event.isError || isCommandTool(event.toolName))
        ? verboseStepOutput(event.result)
        : undefined;
    return output ? { ...detail, output } : detail;
  }

  private fallbackField(): { fallbackModel?: string } {
    return this.fallbackModel ? { fallbackModel: this.fallbackModel } : {};
  }

  private publishNotice(kind: Extract<ConversationAgentEvent, { type: "conversation_notice" }>["kind"]): void {
    this.flush();
    this.publish({
      type: "conversation_notice",
      conversationId: this.conversationId,
      requestId: this.request?.requestId,
      kind,
    });
  }

  private clearTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}

export function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : "tool-call";
}
