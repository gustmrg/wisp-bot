import { describe, expect, it } from "vitest";

import { PiEventTranslator } from "../backend/pi-event-translator.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";

describe("PiEventTranslator", () => {
  it("reports registered integration tools while filtering unknown tool names", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "plugins-1", text: "Search" });
    for (const toolName of [
      "web_search",
      "web_read",
      "firecrawl_scrape",
      "linear_update_issue",
      "unknown_plugin",
      "constructor",
      "bash",
    ])
      translator.handle({ type: "tool_execution_start", toolCallId: `call-${toolName}`, toolName });
    expect(events.filter((event) => event.type === "tool_activity").map((event) => event.toolName)).toEqual([
      "web_search",
      "web_read",
      "firecrawl_scrape",
      "linear_update_issue",
    ]);
    translator.dispose();
  });

  it("tells what each step works on and how a command ended", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0, "/workspace");
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Test it" });
    translator.handle({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "/workspace/src/app.ts" },
    });
    translator.handle({
      type: "tool_execution_start",
      toolCallId: "run-1",
      toolName: "run_command",
      args: { command: "npm test -- --token=abc", description: "Run the tests" },
    });
    translator.handle({
      type: "tool_execution_end",
      toolCallId: "run-1",
      toolName: "run_command",
      isError: true,
      result: { content: [{ type: "text", text: "secret output" }], details: { commandResult: { exitCode: 1 } } },
    });

    expect(events.filter((event) => event.type === "tool_activity").map((event) => event.detail)).toEqual([
      { target: "src/app.ts" },
      { purpose: "Run the tests", commandOutline: "npm test" },
      { commandResult: { exitCode: 1 } },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret output");
    expect(JSON.stringify(events)).not.toContain("token=abc");
    translator.dispose();
  });

  it("shows commands as written and the end of their output only with verbose steps", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0, "/workspace");
    const run = (id: string) => {
      translator.handle({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "run_command",
        args: { command: "npm test -- --token=abc" },
      });
      translator.handle({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "run_command",
        isError: false,
        result: { content: [{ type: "text", text: "3 passed" }] },
      });
    };
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Test it" });
    run("run-1");
    translator.setDisplay({ showReasoning: false, verboseSteps: true });
    run("run-2");
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a.md" } });
    translator.handle({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "file body" }] },
    });
    translator.handle({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "a.md" } });
    translator.handle({
      type: "tool_execution_end",
      toolCallId: "edit-1",
      toolName: "edit",
      isError: true,
      result: { content: [{ type: "text", text: "Text not found" }] },
    });

    const details = Object.fromEntries(
      events.flatMap((event) =>
        event.type === "tool_activity" ? [[`${event.toolCallId}:${event.phase}`, event.detail]] : [],
      ),
    );
    expect(details["run-1:started"]).not.toHaveProperty("command");
    expect(details["run-1:completed"]).toBeUndefined();
    expect(details["run-2:started"]).toMatchObject({ command: "npm test -- --token=abc" });
    expect(details["run-2:completed"]).toEqual({ output: "3 passed" });
    // A file's content stays out; why a step failed shows.
    expect(details["read-1:completed"]).toBeUndefined();
    expect(details["edit-1:completed"]).toEqual({ output: "Text not found" });
  });

  it("sends the model's reasoning with the message it precedes only while the Wisp shows it", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    const thinking = (delta: string) =>
      translator.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Plan it" });
    translator.handle({ type: "agent_start" });
    thinking("hidden");
    translator.setDisplay({ showReasoning: true, verboseSteps: false });
    thinking("Check the file first.");
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    translator.handle({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
    thinking(" Then answer.");
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } });
    translator.handle({ type: "agent_settled" });

    const reasoning = events.filter((event) => event.type === "assistant_reasoning_delta");
    expect(reasoning.map((event) => [event.messageId, event.delta])).toEqual([
      // A part with reasoning alone stays open, so its reasoning goes with the text that follows.
      ["r1:assistant", "Check the file first."],
      ["r1:assistant", " Then answer."],
    ]);
    expect(JSON.stringify(events)).not.toContain("hidden");
    expect(events.at(-2)).toMatchObject({ type: "assistant_message_completed", messageId: "r1:assistant" });
  });

  it("does not count reasoning as an answer", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.setDisplay({ showReasoning: true, verboseSteps: false });
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Plan it" });
    translator.handle({ type: "agent_start" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Hmm" } });
    translator.handle({ type: "agent_settled" });
    expect(events).toContainEqual(expect.objectContaining({ type: "conversation_error", requestId: "r1" }));
  });

  it("answers a follow-up with the rest of the turn, even when the reply before it used tools alone", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "r1", text: "Look it up" });
    translator.handle({ type: "agent_start" });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    translator.handle({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
    translator.takeFollowUp({ conversationId: "wisp-1", requestId: "r2", text: "Only the summary" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Summary" } });
    translator.handle({ type: "agent_settled" });

    expect(
      events
        .filter(({ type }) => type !== "conversation_status")
        .map((event) => `${event.type}:${"requestId" in event ? event.requestId : ""}`),
    ).toEqual([
      "assistant_message_started:r1",
      "tool_activity:r1",
      "tool_activity:r1",
      // Empty, so hidden in the transcript; the request still counts as answered.
      "assistant_message_completed:r1",
      "follow_up_taken:r1",
      "assistant_message_started:r2",
      "assistant_text_delta:r2",
      "assistant_message_completed:r2",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "follow_up_taken", requestId: "r1", followUpId: "r2" }),
    );
  });

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
      // Text before a tool call is its own message; nothing followed the tools.
      "assistant_message_completed",
      "tool_activity",
      "tool_activity",
      "tool_activity",
      "conversation_notice",
      "conversation_notice",
      "conversation_notice",
      "conversation_notice",
      "conversation_status",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "assistant_text_delta",
        delta: "Hello world",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "assistant_message_started",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_activity",
        toolName: "read",
        phase: "completed",
        isError: false,
      }),
    );
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("bash-1");
  });

  it("passes a tool's own progress text through, bounded and without control characters", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "request-1", text: "Read" });

    translator.handle({
      type: "tool_execution_update",
      toolCallId: "read-1",
      toolName: "read",
      partialResult: { content: [], details: { activityLabel: "Reading with\nVision, page 1 of 2…" } },
    });
    translator.handle({
      type: "tool_execution_update",
      toolCallId: "read-1",
      toolName: "read",
      partialResult: { details: { activityLabel: "x".repeat(500) } },
    });
    translator.handle({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: {} });

    const labels = events.filter((event) => event.type === "tool_activity").map((event) => event.label);
    expect(labels).toEqual(["Reading with Vision, page 1 of 2…", "x".repeat(160), undefined]);
  });

  it("splits a reply at tool calls so text written before a tool is its own message", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "request-1", text: "Search" });

    translator.handle({ type: "agent_start" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me look." } });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    translator.handle({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
    // A second tool call without new text does not add an empty message.
    translator.handle({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read" });
    translator.handle({ type: "tool_execution_end", toolCallId: "read-2", toolName: "read", isError: false });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found it." } });
    translator.handle({ type: "agent_settled" });

    const messageEvents = events.flatMap((event) =>
      "messageId" in event && event.type !== "conversation_error"
        ? [{ type: event.type, messageId: event.messageId }]
        : [],
    );
    expect(messageEvents).toEqual([
      { type: "assistant_message_started", messageId: "request-1:assistant" },
      { type: "assistant_text_delta", messageId: "request-1:assistant" },
      { type: "assistant_message_completed", messageId: "request-1:assistant" },
      { type: "assistant_message_started", messageId: "request-1:assistant:2" },
      { type: "assistant_text_delta", messageId: "request-1:assistant:2" },
      { type: "assistant_message_completed", messageId: "request-1:assistant:2" },
    ]);
  });

  it("does not split a message without visible text, and reports later errors on the current part", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "request-1", text: "Search" });

    translator.handle({ type: "agent_start" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\n " } });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    expect(events.filter(({ type }) => type === "assistant_message_completed")).toHaveLength(0);

    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking." } });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read" });
    translator.handle({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "Provider unavailable" },
    });
    translator.handle({ type: "agent_settled" });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "conversation_error", messageId: "request-1:assistant:2" }),
    );
  });

  it("marks the next part stopped when the reply is cancelled after a tool call", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "request-1", text: "Search" });

    translator.handle({ type: "agent_start" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me look." } });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    translator.markCancelled();
    translator.handle({ type: "agent_settled" });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "assistant_message_completed", messageId: "request-1:assistant" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "assistant_message_cancelled", messageId: "request-1:assistant:2" }),
    );
  });

  it("maps aborted streams and surfaces the final provider error", () => {
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
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", stopReason: "error", errorMessage: "400 invalid max tokens" },
      },
    });
    failedTranslator.handle({ type: "agent_settled" });

    expect(failed).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        error: expect.objectContaining({
          message: "The provider rejected the request. Check the model settings and try again.",
          retryable: false,
          detail: "400 invalid max tokens",
        }),
      }),
    );
    expect(failed.some(({ type }) => type === "assistant_message_completed")).toBe(false);
  });

  it("hides the raw provider body behind a friendly message and keeps it as detail", () => {
    const events: ConversationAgentEvent[] = [];
    const rawBody = '{"message":"This model is unavailable for free. The paid version is available now","code":404}';
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "unavailable-1", text: "Hi" });
    translator.handle({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { role: "assistant", stopReason: "error", errorMessage: `OpenRouter API error (404): ${rawBody}` },
      },
    });
    translator.handle({ type: "agent_settled" });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        error: expect.objectContaining({
          message: "This model is unavailable. Choose a different model in the model settings.",
          retryable: false,
          detail: `OpenRouter API error (404): ${rawBody}`,
        }),
      }),
    );
    const serialized = JSON.stringify(events);
    const escapedBody = JSON.stringify(rawBody).slice(1, -1);
    expect(serialized.indexOf(escapedBody)).toBe(
      serialized.lastIndexOf(escapedBody),
      "raw body must appear only once, inside the detail field",
    );
    expect(serialized.indexOf(escapedBody)).toBeGreaterThan(serialized.indexOf('"detail"'));
  });

  it("turns an empty settled response into a failed assistant message", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "empty-1", text: "Fail" });
    translator.handle({ type: "agent_start" });
    translator.handle({ type: "agent_settled" });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        error: expect.objectContaining({ message: "The model request failed." }),
      }),
    );
    expect(events.some(({ type }) => type === "assistant_message_completed")).toBe(false);
  });

  it("announces the fallback model and marks only the parts it wrote", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "request-1", text: "Search" });

    translator.handle({ type: "agent_start" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me look." } });
    translator.handle({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    translator.handle({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false });
    translator.handle({ type: "model_fallback", model: "Backup" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found it." } });
    translator.handle({ type: "agent_settled" });

    expect(events).toContainEqual({
      type: "conversation_notice",
      conversationId: "wisp-1",
      requestId: "request-1",
      kind: "fallback_started",
    });
    expect(events.filter((event) => event.type === "assistant_message_completed")).toEqual([
      expect.not.objectContaining({ fallbackModel: expect.anything() }),
      expect.objectContaining({ messageId: "request-1:assistant:2", fallbackModel: "Backup" }),
    ]);
    expect(events.some((event) => event.type === "conversation_error")).toBe(false);

    // The next turn starts on the Wisp's own model.
    translator.begin({ conversationId: "wisp-1", requestId: "request-2", text: "Again" });
    translator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Sure." } });
    translator.handle({ type: "agent_settled" });
    expect(events.at(-2)).toEqual(
      expect.objectContaining({ type: "assistant_message_completed", messageId: "request-2:assistant" }),
    );
    expect(events.at(-2)).not.toHaveProperty("fallbackModel");
  });

  it("does not announce SDK retries for permanent HTTP failures", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 0);
    translator.begin({ conversationId: "wisp-1", requestId: "retry-1", text: "Fail" });
    translator.handle({ type: "auto_retry_start", errorMessage: "404 Provider returned error" });
    translator.handle({ type: "auto_retry_end", success: false, finalError: "404 Provider returned error" });
    translator.handle({ type: "agent_settled" });

    expect(events.some((event) => event.type === "conversation_notice")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        error: expect.objectContaining({ retryable: false }),
      }),
    );
  });

  it("bounds individual event payloads and the total streamed response", () => {
    const events: ConversationAgentEvent[] = [];
    const translator = new PiEventTranslator("wisp-1", (event) => events.push(event), 100);
    translator.begin({ conversationId: "wisp-1", requestId: "large-1", text: "Large" });
    translator.handle({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x".repeat(500_001) },
    });
    translator.handle({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit" });
    translator.handle({ type: "agent_settled" });

    const deltas = events.filter(
      (event): event is Extract<ConversationAgentEvent, { type: "assistant_text_delta" }> =>
        event.type === "assistant_text_delta",
    );
    expect(deltas.every(({ delta }) => delta.length <= 8_000)).toBe(true);
    expect(deltas.reduce((total, { delta }) => total + delta.length, 0)).toBe(500_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "conversation_error",
        error: expect.objectContaining({ retryable: false }),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_activity", toolName: "edit" }));
  });
});
