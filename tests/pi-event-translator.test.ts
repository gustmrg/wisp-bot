import { describe, expect, it } from "vitest";

import { PiEventTranslator } from "../electron/backend/pi-event-translator.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";

describe("PiEventTranslator", () => {
  it("coalesces text, filters thinking and unsafe tools, and preserves lifecycle order", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 100);
    translator.begin({ conversationId: "wisp-1", requestId: "request-1", text: "Inspect" });

    translator.handle({ type: "agent_start" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    translator.handle({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read" });
    translator.handle({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
    translator.handle({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash" });
    translator.handle({ type: "auto_retry_start" });
    translator.handle({ type: "auto_retry_end" });
    translator.handle({ type: "compaction_start" });
    translator.handle({ type: "compaction_end" });
    translator.handle({ type: "agent_settled" });

    expect(events.map(({ type }) => type)).toEqual([
      "conversation_status",
      "assistant_message_started",
      "assistant_text_delta",
      "tool_activity",
      "tool_activity",
      "tool_activity",
      "conversation_notice",
      "conversation_notice",
      "conversation_notice",
      "conversation_notice",
      "assistant_message_completed",
      "conversation_status",
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant_text_delta",
      delta: "Hello world",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_activity",
      toolName: "read",
      phase: "completed",
      isError: false,
    }));
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("bash-1");
  });

  it("maps aborted and failed streams without exposing provider errors", () => {
    const aborted: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => aborted.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "abort-1", text: "Stop" });
    translator.handle({
      type: "message_update",
      assistantMessageEvent: { type: "error", reason: "aborted" },
    });
    translator.handle({ type: "agent_settled" });
    expect(aborted.some(({ type }) => type === "assistant_message_cancelled")).toBe(true);

    const failed: ConversationAgentEvent[] = [];
    const failedTranslator = new PiEventTranslator("wisp-1", (event) => failed.push(event), 0);
    failedTranslator.begin({ conversationId: "wisp-1", requestId: "fail-1", text: "Fail" });
    failedTranslator.handle({
      type: "message_update",
      assistantMessageEvent: { type: "error", reason: "error", delta: "provider secret" },
    });
    failedTranslator.handle({ type: "agent_settled" });

    expect(failed).toContainEqual(expect.objectContaining({
      type: "conversation_error",
      error: expect.objectContaining({ message: "The model request failed." }),
    }));
    expect(JSON.stringify(failed)).not.toContain("provider secret");
    expect(failed.some(({ type }) => type === "assistant_message_completed")).toBe(false);
  });
});
