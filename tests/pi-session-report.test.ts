import { describe, expect, it } from "vitest";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { buildSessionReport, summarizeToolArguments } from "../electron/backend/pi-session-report.js";
import type { ModelPricing } from "../electron/backend/model-pricing-service.js";

const WORKSPACE = "/wisp/workspaces/session-1";
const PRICING: ModelPricing = {
  inputPerMillionTokens: 1.5,
  outputPerMillionTokens: 3,
  cacheReadPerMillionTokens: 0.15,
};
const getPricing = (providerId: string, modelId: string): ModelPricing | null =>
  providerId === "openrouter" && modelId === "openai/gpt-oss-120b" ? PRICING : null;

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Working on it." }],
    api: "openai",
    provider: "openrouter",
    model: "openai/gpt-oss-120b",
    usage: {
      input: 1_000,
      output: 200,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 1_300,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_000,
    ...overrides,
  };
}

function messageEntry(message: Record<string, unknown>, timestamp = "2026-09-01T10:00:00.000Z"): SessionEntry {
  return {
    type: "message",
    id: `entry-${Math.random()}`,
    parentId: null,
    timestamp,
    message,
  } as unknown as SessionEntry;
}

function toolResultEntry(toolCallId: string, isError: boolean, timestamp = "2026-09-01T10:00:01.000Z"): SessionEntry {
  return messageEntry({ role: "toolResult", toolCallId, toolName: "read", content: [], isError, timestamp }, timestamp);
}

describe("buildSessionReport", () => {
  it("includes bundled plugin tools with private arguments hidden and filters unknown tools", () => {
    const entries = [
      messageEntry(
        assistantMessage({
          content: [
            { type: "toolCall", id: "web-1", name: "web_search", arguments: { query: "PRIVATE SEARCH" } },
            {
              type: "toolCall",
              id: "linear-1",
              name: "linear_update_issue",
              arguments: { id: "PRIVATE ID", title: "PRIVATE TITLE", description: "PRIVATE BODY" },
            },
            { type: "toolCall", id: "unknown-1", name: "unknown_plugin", arguments: {} },
          ],
        }),
      ),
      toolResultEntry("linear-1", false),
    ];
    const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });
    expect(report.toolCalls.map(({ toolName }) => toolName)).toEqual(["web_search", "linear_update_issue"]);
    expect(report.toolCalls[0]?.argumentSummary).toBe("query: [value hidden]");
    expect(report.toolCalls[1]).toMatchObject({ status: "completed" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });

  it("aggregates token usage per model and for the whole session", () => {
    const entries = [
      messageEntry(assistantMessage()),
      messageEntry(assistantMessage({ usage: { input: 500, output: 50, cacheRead: 0, totalTokens: 550 } })),
    ];

    const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });

    expect(report.turns).toBe(2);
    expect(report.totals).toEqual({
      inputTokens: 1_500,
      outputTokens: 250,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      totalTokens: 1_850,
      costUsd: (1_500 / 1_000_000) * 1.5 + (250 / 1_000_000) * 3 + (100 / 1_000_000) * 0.15,
    });
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b",
      turns: 2,
      usage: { inputTokens: 1_500, outputTokens: 250, totalTokens: 1_850 },
    });
  });

  it("omits cost when pricing is unavailable for a model used", () => {
    const entries = [messageEntry(assistantMessage()), messageEntry(assistantMessage({ model: "unknown/model-x" }))];

    const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });

    expect(report.totals.costUsd).toBeNull();
    expect(report.models.find((model) => model.modelId === "unknown/model-x")?.costUsd).toBeNull();
    expect(report.models.find((model) => model.modelId === "openai/gpt-oss-120b")?.costUsd).not.toBeNull();
  });

  it("reports tool calls with sanitized arguments and resolved status", () => {
    const entries = [
      messageEntry(
        assistantMessage({
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: `${WORKSPACE}/src/foo.ts` },
            },
            {
              type: "toolCall",
              id: "call-2",
              name: "edit",
              arguments: {
                path: `${WORKSPACE}/src/foo.ts`,
                oldString: "TOP SECRET CONTENT",
                newString: "MORE SECRET CONTENT",
              },
            },
            {
              type: "toolCall",
              id: "call-3",
              name: "grep",
              arguments: { pattern: "wisp", include: "*.ts" },
            },
            { type: "toolCall", id: "call-4", name: "bash", arguments: { command: "rm -rf /" } },
          ],
        }),
      ),
      toolResultEntry("call-1", false),
      toolResultEntry("call-2", true),
    ];

    const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });

    expect(report.toolCalls).toHaveLength(3);
    expect(report.toolCalls[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "read",
      argumentSummary: "path: [workspace path]",
      status: "completed",
    });
    expect(report.toolCalls[1]).toMatchObject({ toolName: "edit", status: "error" });
    expect(report.toolCalls[1].argumentSummary).not.toContain("SECRET");
    expect(report.toolCalls[2]).toMatchObject({
      toolName: "grep",
      argumentSummary: "pattern: [value hidden]; include: [value hidden]",
      status: "pending",
    });
  });

  it("caps the reported tool calls and events", () => {
    const entries = Array.from({ length: 80 }, (_, index) =>
      messageEntry(
        assistantMessage({
          content: [{ type: "toolCall", id: `call-${index}`, name: "ls", arguments: { path: "." } }],
        }),
      ),
    );

    const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });

    expect(report.toolCalls).toHaveLength(50);
    expect(report.toolCalls[0].toolCallId).toBe("call-30");
    expect(report.toolCalls[49].toolCallId).toBe("call-79");
  });

  it("reports compaction and sanitized error events", () => {
    const entries = [
      {
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: "2026-09-01T11:00:00.000Z",
        summary: "s",
        firstKeptEntryId: "e1",
        tokensBefore: 12_345,
      } as unknown as SessionEntry,
      messageEntry(
        assistantMessage({ stopReason: "error", errorMessage: "Provider exploded with /home/gustavo/secret.txt" }),
        "2026-09-01T12:00:00.000Z",
      ),
    ];

    const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });

    expect(report.events).toHaveLength(2);
    expect(report.events[0]).toMatchObject({ kind: "compaction", detail: "Context compacted (12,345 tokens before)" });
    expect(report.events[1].kind).toBe("error");
    expect(report.events[1].detail).not.toContain("Provider exploded");
    expect(report.events[1].detail).not.toContain("/home/gustavo/secret.txt");
  });
});

describe("summarizeToolArguments", () => {
  it("drops non-whitelisted values and hides path text", () => {
    const longPath = `${WORKSPACE}/${"a".repeat(300)}.ts`;

    const summary = summarizeToolArguments({ path: longPath, content: "SECRET FILE CONTENT" }, WORKSPACE);

    expect(summary).not.toContain("SECRET");
    expect(summary.length).toBeLessThanOrEqual(201);
    expect(summary).toBe("path: [workspace path]");
  });

  it("returns an empty summary for non-object arguments", () => {
    expect(summarizeToolArguments("read", WORKSPACE)).toBe("");
    expect(summarizeToolArguments(null, WORKSPACE)).toBe("");
    expect(summarizeToolArguments([1, 2], WORKSPACE)).toBe("");
  });

  it("relativizes both forward- and backslash workspace paths", () => {
    expect(summarizeToolArguments({ path: "/wisp/workspaces/session-1/a.ts" }, WORKSPACE)).toBe(
      "path: [workspace path]",
    );
    expect(
      summarizeToolArguments({ path: "\\wisp\\workspaces\\session-1\\a.ts" }, "\\wisp\\workspaces\\session-1"),
    ).toBe("path: [workspace path]");
  });
});

it("hides arbitrary secrets in search arguments and provider errors, and reads safe runtime notices", () => {
  const entries = [
    messageEntry(assistantMessage({ stopReason: "error", errorMessage: "Authorization: Bearer PRIVATE_CREDENTIAL" })),
    { type: "custom", customType: "wisp:runtime", data: { version: "0.84.4" }, timestamp: "2026-09-01T12:00:00Z" },
    {
      type: "custom",
      customType: "wisp:retry",
      data: { phase: "started", error: "PRIVATE_CREDENTIAL" },
      timestamp: "2026-09-01T12:00:01Z",
    },
    { type: "custom", customType: "wisp:retry", data: { phase: "finished" }, timestamp: "2026-09-01T12:00:02Z" },
  ] as SessionEntry[];
  const report = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });
  expect(report.piVersion).toBe("0.84.4");
  expect(report.events.map((event) => event.kind)).toEqual(["error", "retry_started", "retry_finished"]);
  expect(JSON.stringify(report)).not.toContain("PRIVATE_CREDENTIAL");
  expect(
    summarizeToolArguments(
      { pattern: "PRIVATE_CREDENTIAL", query: "PRIVATE PROMPT", path: "/outside/secret" },
      WORKSPACE,
    ),
  ).not.toMatch(/PRIVATE|outside/);
});

it("includes cache writes in estimates and treats a missing cache-write price as unknown", () => {
  const entries = [
    messageEntry(assistantMessage({ usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 50 } })),
  ];
  const unknown = buildSessionReport("session-1", entries, { workspaceDirectory: WORKSPACE, getPricing });
  expect(unknown.totals.costUsd).toBeNull();
  expect(unknown.totals.totalTokens).toBe(180);
  const priced = buildSessionReport("session-1", entries, {
    workspaceDirectory: WORKSPACE,
    getPricing: () => ({ ...PRICING, cacheWritePerMillionTokens: 2 }),
  });
  expect(priced.totals.costUsd).toBeCloseTo(0.000283);
});

it("includes summarization usage and keeps unknown summary prices unknown", () => {
  const entry = {
    type: "compaction",
    id: "compact",
    parentId: null,
    timestamp: "2026-09-05T00:00:00Z",
    summary: "Summary",
    firstKeptEntryId: "kept",
    tokensBefore: 9000,
    usage: {
      input: 9000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 9500,
      cost: { input: 0.009, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
  } as SessionEntry;
  const report = buildSessionReport("session", [entry], { workspaceDirectory: WORKSPACE, getPricing });
  expect(report.totals).toMatchObject({ totalTokens: 9500, costUsd: 0.01 });
  expect(report.compactionUsage?.totalTokens).toBe(9500);
  expect(report.turns).toBe(0);
  const unknown = structuredClone(entry);
  if (unknown.type === "compaction" && unknown.usage) unknown.usage.cost.total = 0;
  expect(
    buildSessionReport("session", [unknown], { workspaceDirectory: WORKSPACE, getPricing }).totals.costUsd,
  ).toBeNull();
});

it("falls back to the cost Pi recorded when no current price is available", () => {
  const entries = [
    messageEntry(
      assistantMessage({
        provider: "zai",
        model: "glm-5.3-flash",
        usage: { input: 124, output: 262, cacheRead: 1728, cacheWrite: 0, cost: { total: 0.0001 } },
      }),
    ),
    messageEntry(
      assistantMessage({
        provider: "zai",
        model: "glm-5.3-flash",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "error",
      }),
    ),
    messageEntry(
      assistantMessage({ usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 99 } } }),
    ),
  ];
  const report = buildSessionReport("session", entries, { workspaceDirectory: WORKSPACE, getPricing });
  expect(report.models.find((model) => model.modelId === "glm-5.3-flash")?.costUsd).toBeCloseTo(0.0001);
  // Current OpenRouter prices still take precedence over the recorded cost.
  expect(report.models.find((model) => model.modelId === "openai/gpt-oss-120b")?.costUsd).toBeCloseTo(0.0015);
  expect(report.totals.costUsd).toBeCloseTo(0.0016);
});
