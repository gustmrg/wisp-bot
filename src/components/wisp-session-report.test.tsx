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
    expect(await screen.findByText("1,850")).toBeVisible();
    expect(screen.getByText("$0.0023")).toBeVisible();
    expect(screen.queryByText("read")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session details" }));
    expect(await screen.findByText("openai/gpt-oss-120b · 3 turns")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Tool calls (1)" }));
    expect(await screen.findByText("read")).toBeVisible();
    expect(screen.getByText("path: ./src/foo.ts")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Events (1)" }));
    expect(await screen.findByText(/Context compacted/)).toBeVisible();
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

    expect(await screen.findByText(/Includes 1,000 tokens used by the image model/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Session details" }));
    expect(await screen.findByText("vision · image model · 2 calls")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Tool calls (2)" }));
    expect(await screen.findByText("Read with Vision (OpenAI)")).toBeVisible();
    expect(screen.getByText("From Vision (OpenAI)'s saved transcription")).toBeVisible();
  });

  it("refreshes on demand and when returning to Usage", async () => {
    const user = userEvent.setup();
    const getSessionReport = exposeApi(vi.fn(async () => ({ ok: true as const, value: report })));
    const { rerender } = render(<WispSessionReportSection chatId="wisp-1" />);
    expect(await screen.findByText("1,850")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getSessionReport).toHaveBeenCalledTimes(2));
    rerender(<WispSessionReportSection chatId="wisp-1" active={false} />);
    rerender(<WispSessionReportSection chatId="wisp-1" active />);
    await waitFor(() => expect(getSessionReport).toHaveBeenCalledTimes(3));
  });

  it("shows an empty state when the Wisp has no session", async () => {
    exposeApi(vi.fn(async () => ({ ok: true as const, value: null })));
    render(<WispSessionReportSection chatId="wisp-1" />);
    expect(await screen.findByText(/No agent session yet/i)).toBeVisible();
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
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("1,850")).toBeVisible();
    expect(getSessionReport).toHaveBeenCalledTimes(2);
  });
});
