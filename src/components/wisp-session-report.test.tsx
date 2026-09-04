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
  it("loads the report lazily when expanded and renders its summary", async () => {
    const user = userEvent.setup();
    const getSessionReport = exposeApi(vi.fn(async () => ({ ok: true as const, value: report })));

    render(<WispSessionReportSection chatId="wisp-1" />);

    expect(getSessionReport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Session activity/i }));

    await waitFor(() => {
      expect(screen.getByText("openai/gpt-oss-120b · 3 turns")).toBeVisible();
    });
    expect(screen.getByText(/1,500 in · 250 out · 1,850 total/)).toBeVisible();
    expect(screen.getByText("$0.0023")).toBeVisible();
    expect(screen.getByText("read")).toBeVisible();
    expect(screen.getByText("path: ./src/foo.ts")).toBeVisible();
    expect(screen.getByText(/Context compacted/)).toBeVisible();
    expect(getSessionReport).toHaveBeenCalledWith({ conversationId: "wisp-1" });
  });

  it("refreshes the report on demand", async () => {
    const user = userEvent.setup();
    const getSessionReport = exposeApi(vi.fn(async () => ({ ok: true as const, value: report })));

    render(<WispSessionReportSection chatId="wisp-1" />);
    await user.click(screen.getByRole("button", { name: /Session activity/i }));
    await waitFor(() => {
      expect(screen.getByText("openai/gpt-oss-120b · 3 turns")).toBeVisible();
    });

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(getSessionReport).toHaveBeenCalledTimes(2);
    });
  });

  it("shows an empty state when the Wisp has no session", async () => {
    const user = userEvent.setup();
    exposeApi(vi.fn(async () => ({ ok: true as const, value: null })));

    render(<WispSessionReportSection chatId="wisp-1" />);
    await user.click(screen.getByRole("button", { name: /Session activity/i }));

    expect(await screen.findByText(/No agent session yet/i)).toBeVisible();
  });

  it("shows backend errors with a retry", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const getSessionReport = exposeApi(
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? {
              ok: false as const,
              error: {
                code: "internal_error" as const,
                message: "The session is too large to summarize.",
                retryable: false,
              },
            }
          : { ok: true as const, value: report };
      }),
    );

    render(<WispSessionReportSection chatId="wisp-1" />);
    await user.click(screen.getByRole("button", { name: /Session activity/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The session is too large to summarize.");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(screen.getByText("openai/gpt-oss-120b · 3 turns")).toBeVisible();
    });
    expect(getSessionReport).toHaveBeenCalledTimes(2);
  });
});
