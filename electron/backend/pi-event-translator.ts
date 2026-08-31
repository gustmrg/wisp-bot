import type {
  BackendError,
  ConversationAgentEvent,
  SendMessageRequest,
} from "../../shared/contracts.js";

const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const MAX_DELTA_CHARACTERS = 8_000;
const MAX_RESPONSE_CHARACTERS = 500_000;

export type PiAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "agent_settled" }
  | {
      type: "message_update";
      assistantMessageEvent: { type: string; delta?: string; reason?: string };
    }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "auto_retry_start" }
  | { type: "auto_retry_end" }
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
          this.startMessage();
          this.queueDelta(update.delta);
        } else if (update.type === "error") {
          if (update.reason === "aborted") this.cancelled = true;
          else this.reportError({ code: "internal_error", message: "The model request failed.", retryable: true });
        }
        break;
      }
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
        this.publishNotice("retry_started");
        break;
      case "auto_retry_end":
        this.publishNotice("retry_finished");
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
    } else if (!this.failed) {
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
    });
  }

  private queueDelta(delta: string): void {
    if (!delta || this.failed) return;
    const remaining = MAX_RESPONSE_CHARACTERS - this.responseCharacters;
    if (remaining <= 0) {
      this.reportError({ code: "internal_error", message: "The model response exceeded the supported size.", retryable: false });
      return;
    }
    const accepted = delta.slice(0, remaining);
    this.responseCharacters += accepted.length;
    for (let offset = 0; offset < accepted.length; offset += MAX_DELTA_CHARACTERS) {
      this.pendingDelta += accepted.slice(offset, offset + MAX_DELTA_CHARACTERS);
      if (this.pendingDelta.length >= MAX_DELTA_CHARACTERS) this.flush();
    }
    if (accepted.length < delta.length) {
      this.reportError({ code: "internal_error", message: "The model response exceeded the supported size.", retryable: false });
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
