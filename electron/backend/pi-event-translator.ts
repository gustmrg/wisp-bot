import type { BackendError, ConversationAgentEvent, SendMessageRequest } from "../../shared/contracts.js";

const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const MAX_DELTA_CHARACTERS = 8_000;
const MAX_RESPONSE_CHARACTERS = 500_000;
const MAX_ERROR_CHARACTERS = 2_000;
const GENERIC_ERROR_MESSAGE = "The model request failed.";

export interface PiAssistantMessageSnapshot {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function sanitizeErrorMessage(value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= MAX_ERROR_CHARACTERS) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_CHARACTERS)}…`;
}

export function isRetryableProviderError(message: string): boolean {
  const status = message.match(/(?:^|\D)(4\d\d|5\d\d)(?:\D|$)/)?.[1];
  if (status) {
    const code = Number(status);
    return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500;
  }
  return /rate.?limit|too many requests|overload|service.?unavailable|server.?error|internal.?error|network|connection|timed? out|timeout|fetch failed|try again|please retry/i.test(
    message,
  );
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
  | { type: "message_end"; message?: PiAssistantMessageSnapshot }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "auto_retry_start"; errorMessage?: string }
  | { type: "auto_retry_end"; success?: boolean; finalError?: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" };

type EventPublisher = (event: ConversationAgentEvent) => void;

export class PiEventTranslator {
  private readonly conversationId: string;
  private readonly publish: EventPublisher;
  private readonly flushDelayMs: number;
  private request: SendMessageRequest | null = null;
  private messageId = "";
  private messageStarted = false;
  private pendingDelta = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private failed = false;
  private cancelled = false;
  private responseCharacters = 0;
  private lastErrorMessage = "";
  private retryNoticeVisible = false;

  constructor(conversationId: string, publish: EventPublisher, flushDelayMs = 24) {
    this.conversationId = conversationId;
    this.publish = publish;
    this.flushDelayMs = flushDelayMs;
  }

  begin(request: SendMessageRequest): void {
    this.clearTimer();
    this.request = request;
    this.messageId = `${request.requestId}:assistant`;
    this.messageStarted = false;
    this.pendingDelta = "";
    this.failed = false;
    this.cancelled = false;
    this.responseCharacters = 0;
    this.lastErrorMessage = "";
    this.retryNoticeVisible = false;
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
        this.publishTool(event, "started");
        break;
      case "tool_execution_update":
        this.publishTool(event, "updated");
        break;
      case "tool_execution_end":
        this.publishTool(event, "completed", event.isError);
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
      case "compaction_end":
        this.publishNotice("compaction_finished");
        break;
      case "agent_settled":
        this.finish();
        break;
    }
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
      this.reportError({
        code: "internal_error",
        message: this.lastErrorMessage,
        retryable: isRetryableProviderError(this.lastErrorMessage),
      });
    } else if (this.responseCharacters === 0) {
      this.reportError({ code: "internal_error", message: GENERIC_ERROR_MESSAGE, retryable: true });
    } else {
      this.startMessage();
      this.publish({
        type: "assistant_message_completed",
        conversationId: this.conversationId,
        requestId: request.requestId,
        messageId: this.messageId,
      });
    }
    this.publish({ type: "conversation_status", conversationId: this.conversationId, status: "idle" });
    this.request = null;
  }

  dispose(): void {
    this.clearTimer();
    this.request = null;
    this.pendingDelta = "";
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

  private flush(): void {
    this.clearTimer();
    if (!this.request || !this.pendingDelta) return;
    const delta = this.pendingDelta;
    this.pendingDelta = "";
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
  ): void {
    if (!this.request || !ALLOWED_TOOLS.has(event.toolName)) return;
    this.flush();
    this.publish({
      type: "tool_activity",
      conversationId: this.conversationId,
      requestId: this.request.requestId,
      toolCallId: safeId(event.toolCallId),
      toolName: event.toolName,
      phase,
      ...(phase === "completed" ? { isError: Boolean(isError) } : {}),
    });
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

function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : "tool-call";
}
