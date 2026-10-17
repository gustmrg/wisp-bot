import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WispApi, WispSessionReport } from "../../shared/contracts";
import { WispSessionReportSection } from "@/components/wisp-session-report";

const report: WispSessionReport = {
  sessionId: "pi-session-1",
  generatedAt: "2026-09-03T12:00:00.000Z",
  turns: 3,
  totals: {
    inputTokens: 1_500,
    outputTokens: 250,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    totalTokens: 1_850,
    costUsd: 0.0023,
    cacheSavingsUsd: null,
  },
  models: [
    {
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b",
      turns: 3,
      usage: { inputTokens: 1_500, outputTokens: 250, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 1_850 },
      costUsd: 0.0023,
    },
  ],
  toolCalls: [
    {
      toolCallId: "call-1",
      toolName: "read",
      argumentSummary: "path: ./src/foo.ts",
      status: "completed",
      timestamp: "2026-09-01T10:00:00.000Z",
    },
  ],
  events: [
    {
      kind: "compaction",
      timestamp: "2026-09-01T11:00:00.000Z",
      detail: "Context compacted (12,345 tokens before)",
    },
  ],
};

function exposeApi(getSessionReport: WispApi["getSessionReport"]): WispApi["getSessionReport"] {
  const api = { getSessionReport } as WispApi;
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return vi.mocked(getSessionReport);
}

afterEach(() => {
  Object.defineProperty(window, "wisp", { configurable: true, value: undefined });
});

describe("WispSessionReportSection", () => {
  it("loads only in the active Usage tab and keeps technical details collapsed", async () => {
    const user = userEvent.setup();
    const getSessionReport = exposeApi(vi.fn(async () => ({ ok: true as const, value: report })));
    const { rerender } = render(<WispSessionReportSection chatId="wisp-1" active={false} />);
    expect(getSessionReport).not.toHaveBeenCalled();
    rerender(<WispSessionReportSection chatId="wisp-1" active />);
    expect((await screen.findAllByText("1.85K"))[0]).toBeVisible();
    expect(screen.getAllByText("<$0.01")[0]).toBeVisible();
    expect(screen.getByText("Current session · 3 turns")).toBeVisible();
    expect(screen.getByText("6.3%")).toBeVisible();
    expect(screen.getByText("Cache savings").nextElementSibling).toHaveTextContent("Unknown");
    expect(screen.getByTitle("openai/gpt-oss-120b")).toHaveTextContent("gpt-oss-120b");
    expect(screen.queryByText("read")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tool calls/ }));
    expect(await screen.findByText("read")).toBeVisible();
    expect(screen.getByRole("img", { name: "Completed" })).toBeInTheDocument();
    expect(screen.getByText("path: ./src/foo.ts")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Events/ }));
    expect(await screen.findByText(/Context compacted/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Session details" }));
    expect(await screen.findByTitle("pi-session-1")).toBeVisible();
    expect(getSessionReport).toHaveBeenCalledWith({ conversationId: "wisp-1" });
  });

  it("lists image model calls apart from turns and says they are in the totals", async () => {
    const user = userEvent.setup();
    const usage = { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000 };
    exposeApi(
      vi.fn(async () => ({
        ok: true as const,
        value: {
          ...report,
          auxiliaryUsage: usage,
          toolCalls: [
            { ...report.toolCalls[0]!, imageModel: { name: "Vision (OpenAI)", fromCache: false } },
            {
              ...report.toolCalls[0]!,
              toolCallId: "call-2",
              imageModel: { name: "Vision (OpenAI)", fromCache: true },
            },
          ],
          models: [
            ...report.models,
            {
              providerId: "openai",
              modelId: "vision",
              turns: 0,
              usage,
              costUsd: 0.001,
              auxiliary: { task: "imageUnderstanding" as const, calls: 2 },
            },
          ],
        },
      })),
    );
    render(<WispSessionReportSection chatId="wisp-1" active />);

    expect(await screen.findByText("Reading images")).toBeVisible();
    expect(screen.getByText("image model")).toBeVisible();
    expect(screen.getByText(/^2 calls/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Tool calls/ }));
    expect(await screen.findByText("Read with Vision (OpenAI)")).toBeVisible();
    expect(screen.getByText("From Vision (OpenAI)'s saved transcription")).toBeVisible();
  });

  it("refreshes on demand and when returning to Usage", async () => {
    const user = userEvent.setup();
    const getSessionReport = exposeApi(vi.fn(async () => ({ ok: true as const, value: report })));
    const { rerender } = render(<WispSessionReportSection chatId="wisp-1" />);
    expect((await screen.findAllByText("1.85K"))[0]).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getSessionReport).toHaveBeenCalledTimes(2));
    rerender(<WispSessionReportSection chatId="wisp-1" active={false} />);
    rerender(<WispSessionReportSection chatId="wisp-1" active />);
    await waitFor(() => expect(getSessionReport).toHaveBeenCalledTimes(3));
  });

  it("shows an empty state when the Wisp has no session", async () => {
    exposeApi(vi.fn(async () => ({ ok: true as const, value: null })));
    render(<WispSessionReportSection chatId="wisp-1" />);
    expect(await screen.findByText("No session yet")).toBeVisible();
  });

  it("shows backend errors with a retry", async () => {
    const user = userEvent.setup();
    const getSessionReport = exposeApi(
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          error: { code: "internal_error", message: "Could not read session.", retryable: true },
        })
        .mockResolvedValue({ ok: true, value: report }),
    );
    render(<WispSessionReportSection chatId="wisp-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read session.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByText("1.85K"))[0]).toBeVisible();
    expect(getSessionReport).toHaveBeenCalledTimes(2);
  });

  it("filters tool calls, explains unknown prices and links to Token usage", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const call = report.toolCalls[0]!;
    exposeApi(
      vi.fn(async () => ({
        ok: true as const,
        value: {
          ...report,
          totals: { ...report.totals, costUsd: null },
          models: [{ ...report.models[0]!, costUsd: null }],
          toolCalls: [
            call,
            { ...call, toolCallId: "call-2", toolName: "bash", argumentSummary: "npm test", status: "error" as const },
            { ...call, toolCallId: "call-3", toolName: "bash", argumentSummary: "git status" },
          ],
        },
      })),
    );
    render(<WispSessionReportSection chatId="wisp-1" onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/No price is available for gpt-oss-120b/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Tool calls/ }));
    await user.click(await screen.findByRole("button", { name: "Failed 1" }));
    expect(screen.getByText("npm test")).toBeVisible();
    expect(screen.queryByText("git status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "bash 2" }));
    expect(screen.getByText("git status")).toBeVisible();
    expect(screen.queryByText("path: ./src/foo.ts")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compare with other Wisps in Token usage" }));
    expect(onOpenSettings).toHaveBeenCalledWith({ section: "usage" });
  });

  it("names tools readably and shows what each command ran and how it ended", async () => {
    const user = userEvent.setup();
    const call = { argumentSummary: "", status: "completed" as const, timestamp: "2026-09-01T10:00:00.000Z" };
    exposeApi(
      vi.fn(async () => ({
        ok: true as const,
        value: {
          ...report,
          toolCalls: [
            {
              ...call,
              toolCallId: "call-1",
              toolName: "run_command",
              toolLabel: "Run command",
              commandOutline: "cd · npm run build",
              purpose: "Build the app",
              commandResult: { exitCode: 0, durationMs: 4_210 },
            },
            {
              ...call,
              toolCallId: "call-2",
              toolName: "run_command",
              toolLabel: "Run command",
              commandOutline: "npm test",
              commandResult: { stopped: "timeout" as const },
              status: "error" as const,
            },
            {
              ...call,
              toolCallId: "call-3",
              toolName: "mcp_75b04d98ed1b_get_me",
              toolLabel: "GitHub · Get me",
            },
          ],
        },
      })),
    );
    render(<WispSessionReportSection chatId="wisp-1" />);
    await user.click(await screen.findByRole("button", { name: /Tool calls/ }));

    expect(screen.getByText("Build the app")).toBeVisible();
    expect(screen.getByText("cd · npm run build")).toBeVisible();
    expect(screen.getByText("· exit 0 · 4.2s")).toBeVisible();
    expect(screen.getByText("· timed out")).toBeVisible();
    expect(screen.getByText("GitHub · Get me")).toHaveAttribute("title", "mcp_75b04d98ed1b_get_me");
    await user.click(screen.getByRole("button", { name: "Run command 2" }));
    expect(screen.queryByText("GitHub · Get me")).not.toBeInTheDocument();
  });
});
