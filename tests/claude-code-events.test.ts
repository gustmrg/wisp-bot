import { describe, expect, it } from "vitest";

import { ClaudeCodeEventConverter, isMissingSession, wispToolName } from "../backend/claude-code/claude-code-events.js";

const SESSION = "c1744fdc-a3e0-43dd-af93-56e79dbfa64b";

// Messages shaped like those Claude Code 2.1.303 yields through the Agent SDK (account data removed).
const init = {
  type: "system",
  subtype: "init",
  session_id: SESSION,
  model: "claude-sonnet-5-5",
  capabilities: ["interrupt_receipt_v1", 42],
};
const messageStart = {
  type: "stream_event",
  session_id: SESSION,
  parent_tool_use_id: null,
  event: { type: "message_start" },
};
const textDelta = (text: string) => ({
  type: "stream_event",
  session_id: SESSION,
  parent_tool_use_id: null,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});
const toolUse = (id: string, name: string) => ({
  type: "assistant",
  session_id: SESSION,
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id: string, isError?: boolean) => ({
  type: "user",
  session_id: SESSION,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, ...(isError ? { is_error: true } : {}) }],
  },
});
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: SESSION,
  total_cost_usd: 0.00046659,
  usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 649, cache_creation_input_tokens: 2277 },
};

function convertAll(messages: unknown[]) {
  const converter = new ClaudeCodeEventConverter();
  const outputs = messages.map((message) => converter.convert(message));
  return {
    converter,
    events: outputs.flatMap(({ events }) => events),
    results: outputs.flatMap(({ result }) => (result ? [result] : [])),
  };
}

describe("ClaudeCodeEventConverter", () => {
  it("turns a reply into Pi's message events and reads the turn's result", () => {
    const { converter, events, results } = convertAll([
      init,
      messageStart,
      textDelta("Hello"),
      textDelta(" there"),
      success,
    ]);

    expect(events).toEqual([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " there" } },
    ]);
    expect(results).toEqual([
      {
        sessionId: SESSION,
        ok: true,
        usage: { inputTokens: 2, outputTokens: 9, cacheReadTokens: 649, cacheWriteTokens: 2277, totalTokens: 2937 },
        estimatedCostUsd: 0.00046659,
        errors: [],
        reply: "",
      },
    ]);
    expect(converter.model).toBe("claude-sonnet-5-5");
    expect([...converter.capabilities]).toEqual(["interrupt_receipt_v1"]);
  });

  it("reports tool calls under Wisp's tool names", () => {
    const { events } = convertAll([
      toolUse("toolu_1", "mcp__wisp__read"),
      toolResult("toolu_1"),
      toolUse("toolu_2", "WebSearch"),
      toolResult("toolu_2", true),
      toolResult("toolu_unknown"),
    ]);

    expect(events).toEqual([
      { type: "tool_execution_start", toolCallId: "toolu_1", toolName: "read" },
      { type: "tool_execution_end", toolCallId: "toolu_1", toolName: "read", isError: false },
      { type: "tool_execution_start", toolCallId: "toolu_2", toolName: "web_search" },
      { type: "tool_execution_end", toolCallId: "toolu_2", toolName: "web_search", isError: true },
    ]);
  });

  it("ends tools still running when the turn ends, as after a Stop", () => {
    const interrupted = { type: "result", subtype: "error_during_execution", is_error: true, session_id: SESSION };
    const { events, results } = convertAll([toolUse("toolu_1", "mcp__wisp__run_command"), interrupted]);

    expect(events.at(-1)).toEqual({
      type: "tool_execution_end",
      toolCallId: "toolu_1",
      toolName: "run_command",
      isError: true,
    });
    expect(results[0]?.ok).toBe(false);
  });

  it("leaves out what subagents say and do", () => {
    const { events } = convertAll([
      { ...textDelta("inner"), parent_tool_use_id: "toolu_agent" },
      { ...toolUse("toolu_inner", "mcp__wisp__read"), parent_tool_use_id: "toolu_agent" },
    ]);

    expect(events).toEqual([]);
  });

  it("announces retries and compaction, and reads how full the plan is", () => {
    const retry = { type: "system", subtype: "api_retry", attempt: 1, error: "overloaded", session_id: SESSION };
    const rateLimit = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        unifiedWindows: {
          five_hour: { utilization: 0.39, resetsAt: 1792447800 },
          seven_day: { utilization: 0.98, resetsAt: 1792605600 },
        },
      },
    };
    const { converter, events } = convertAll([
      retry,
      retry,
      messageStart,
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "compact_boundary" },
      rateLimit,
    ]);

    expect(events.map(({ type }) => type)).toEqual([
      "auto_retry_start",
      "auto_retry_end",
      "message_start",
      "compaction_start",
      "compaction_end",
    ]);
    expect(converter.planUsage).toEqual({
      status: "allowed_warning",
      windows: {
        five_hour: { utilization: 0.39, resetsAt: 1792447800 },
        seven_day: { utilization: 0.98, resetsAt: 1792605600 },
      },
    });
  });

  it("recognizes a resumed session that no longer exists", () => {
    // The payload Claude Code 2.1.303 returns for `resume` of an unknown session.
    const missing = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [`No conversation found with session ID: ${SESSION}`],
      session_id: SESSION,
    };
    const { results } = convertAll([missing, { ...missing, errors: ["Something else"] }]);

    expect(results.map(isMissingSession)).toEqual([true, false]);
  });

  it("ignores messages it does not understand", () => {
    expect(convertAll([null, 42, "text", { type: "something_new" }]).events).toEqual([]);
  });

  it("maps tool names", () => {
    expect(wispToolName("mcp__wisp__schedule_job")).toBe("schedule_job");
    expect(wispToolName("WebSearch")).toBe("web_search");
    expect(wispToolName("Other")).toBe("Other");
  });
});
