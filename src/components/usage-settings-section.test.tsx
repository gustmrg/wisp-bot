import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsageSettingsSection } from "./usage-settings-section";
import type { ModelUsageRow, UsageReport } from "../../shared/contracts";

const report: UsageReport = {
  generatedAt: "2026-09-05T00:00:00Z",
  from: null,
  period: "all",
  pricingUpdatedAt: null,
  incomplete: false,
  totals: {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 120,
    costUsd: null,
    cacheSavingsUsd: null,
  },
  wisps: [
    {
      conversationId: "one",
      name: "Research Wisp",
      sessions: 2,
      totals: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 120,
        costUsd: null,
        cacheSavingsUsd: null,
      },
    },
  ],
};

function usage(totalTokens: number, costUsd: number | null) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    costUsd,
    cacheSavingsUsd: costUsd === null ? null : 0,
  };
}

function modelRow(key: string, modelId: string | null, totalTokens: number, costUsd: number | null): ModelUsageRow {
  return {
    key,
    kind: modelId === null ? "compaction" : "model",
    providerId: modelId === null ? null : "openrouter",
    modelId,
    turns: modelId === null ? 0 : 1,
    auxiliaryCalls: 0,
    totals: usage(totalTokens, costUsd),
  };
}

const gpt = modelRow("openrouter:openai/gpt-oss-120b", "openai/gpt-oss-120b", 3000, 0.3);
const claude = modelRow("openrouter:anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", 500, 0.5);
const summaries = modelRow("compaction", null, 100, 0.01);

/** Two Wisps: Research used both models and wrote a summary, Inbox used only gpt-oss. */
const byModel: UsageReport = {
  ...report,
  totals: usage(3600, 0.81),
  wisps: [
    {
      conversationId: "one",
      name: "Research Wisp",
      sessions: 2,
      totals: usage(2600, 0.71),
      models: [{ ...gpt, totals: usage(2000, 0.2) }, claude, summaries],
    },
    {
      conversationId: "two",
      name: "Inbox Wisp",
      sessions: 1,
      totals: usage(1000, 0.1),
      models: [{ ...gpt, totals: usage(1000, 0.1) }],
    },
  ],
  models: [gpt, claude, summaries],
};

describe("UsageSettingsSection", () => {
  it("shows usage by model, and narrows the summary and each table to one model", async () => {
    const getUsageReport = vi.fn(async () => ({ ok: true, value: byModel }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    expect(await screen.findByText("Inbox Wisp")).toBeVisible();
    expect(screen.getByRole("radio", { name: "By Wisp" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "By model" }));
    const models = screen.getByRole("table", { name: "Token usage and estimated USD by model" });
    const rows = within(models)
      .getAllByRole("row")
      .map((row) => row.querySelector("th")?.textContent);
    expect(rows).toEqual([
      "Model",
      "claude-sonnet-5-51 turn · 1 Wisp",
      "gpt-oss-120b1 turn · 2 Wisps",
      "Context summariessummaries of long conversations · 1 Wisp",
      "All models",
    ]);

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "gpt-oss-120b" }));
    expect(within(models).getAllByRole("row")).toHaveLength(2);
    expect(within(models).getByText("$0.30")).toBeVisible();
    expect(screen.getAllByText("$0.30")).toHaveLength(2);

    await user.click(screen.getByRole("radio", { name: "By Wisp" }));
    const wisps = screen.getByRole("table", { name: "Token usage and estimated USD by Wisp for gpt-oss-120b" });
    expect(within(wisps).getByText("Research Wisp")).toBeVisible();
    expect(within(wisps).getByText("Inbox Wisp")).toBeVisible();
    expect(within(wisps).getByText("$0.20")).toBeVisible();

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "claude-sonnet-5-5" }));
    // A Wisp that never used the model is left out.
    expect(screen.queryByText("Inbox Wisp")).not.toBeInTheDocument();
    expect(screen.getAllByText("$0.50")[0]).toBeVisible();
  });

  it("stays by Wisp, without a model filter, for a server that does not split by model", async () => {
    Object.defineProperty(window, "wisp", {
      configurable: true,
      value: { getUsageReport: vi.fn(async () => ({ ok: true, value: report })) },
    });
    render(<UsageSettingsSection />);
    expect(await screen.findByText("Research Wisp")).toBeVisible();
    expect(screen.queryByRole("radio", { name: "By model" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
  });

  it("shows per-Wisp usage, filters periods, and refreshes", async () => {
    const getUsageReport = vi.fn(async () => ({ ok: true, value: report }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    expect(await screen.findByText("Research Wisp")).toBeVisible();
    expect(screen.getAllByText("Unknown")[0]).toBeVisible();
    expect(getUsageReport).toHaveBeenCalledWith({ period: "30d" });
    await user.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(getUsageReport).toHaveBeenLastCalledWith({ period: "7d" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getUsageReport).toHaveBeenCalledTimes(3));
  });

  it("keeps the previous report visible while the next period loads", async () => {
    let resolveNext!: (value: unknown) => void;
    const getUsageReport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: report })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          }),
      );
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    expect(await screen.findByText("Research Wisp")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Last 7 days" }));
    expect(screen.getByText("Research Wisp").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading token usage…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    resolveNext({ ok: true, value: { ...report, period: "7d", wisps: [] } });
    expect(await screen.findByText(/No Wisps yet/)).toBeVisible();
    expect(screen.getByText(/No Wisps yet/).closest("[aria-busy]")).toBeNull();
  });

  it("ignores a stale response when the period changes", async () => {
    let resolveFirst!: (value: unknown) => void;
    const getUsageReport = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, value: { ...report, wisps: [] } });
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    await user.click(screen.getByRole("radio", { name: "All history" }));
    expect(await screen.findByText(/No Wisps yet/)).toBeVisible();
    resolveFirst({ ok: true, value: report });
    await waitFor(() => expect(screen.queryByText("Research Wisp")).not.toBeInTheDocument());
  });

  it("allows retry after failure and identifies incomplete history", async () => {
    const getUsageReport = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValue({ ok: true, value: { ...report, incomplete: true } });
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load token usage.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Token totals are partial/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shortens token counts, rounds costs and sorts Wisps by cost", async () => {
    const row = (name: string, totalTokens: number, costUsd: number | null) => ({
      conversationId: name,
      name,
      sessions: 1,
      totals: {
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens,
        costUsd,
        cacheSavingsUsd: costUsd === null ? null : 0.5,
      },
    });
    const wisps = [row("Cheap", 1_234, 0.0021), row("Unpriced", 50, null), row("Busy", 12_400_000, 9.4182)];
    const getUsageReport = vi.fn(async () => ({
      ok: true,
      value: {
        ...report,
        wisps,
        totals: {
          ...report.totals,
          inputTokens: 12_401_284,
          cacheReadTokens: 12_401_284 * 3,
          totalTokens: 12_401_284,
          costUsd: null,
          cacheSavingsUsd: null,
        },
      },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    render(<UsageSettingsSection />);
    expect(await screen.findByText("Busy")).toBeVisible();
    expect(screen.getByText("$9.42+")).toBeVisible();
    expect(screen.getByText("$9.42")).toBeVisible();
    expect(screen.getByText("<$0.01")).toBeVisible();
    expect(screen.getAllByText("12.4M")[0]).toBeVisible();
    expect(screen.getAllByText("12,400,000")[0]).toHaveClass("sr-only");
    expect(screen.getByText(/1 Wisp has an unknown cost/)).toBeVisible();
    // Savings known for two Wisps are a floor for the total.
    expect(screen.getByText("$1.00+")).toBeVisible();
    const names = screen.getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(names).toEqual(["Busy1 session", "Cheap1 session", "Unpriced1 session", "All Wisps"]);
  });

  it("splits input into cached and uncached, with the cache hit rate and savings", async () => {
    const totals = {
      inputTokens: 1_000,
      outputTokens: 4_000,
      cacheReadTokens: 98_000,
      cacheWriteTokens: 1_000,
      totalTokens: 104_000,
      costUsd: 0.5,
      cacheSavingsUsd: 3.25,
    };
    const getUsageReport = vi.fn(async () => ({
      ok: true,
      value: { ...report, totals, wisps: [{ ...report.wisps[0], totals }] },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    render(<UsageSettingsSection />);
    expect(await screen.findByText("Research Wisp")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Cached input" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Uncached input" })).toBeVisible();
    expect(screen.queryByText(/Cache write/)).not.toBeInTheDocument();
    // Cache writes count as uncached input.
    expect(screen.getAllByTitle("2,000 tokens")[0]).toBeVisible();
    expect(screen.getByText("98%")).toBeVisible();
    expect(screen.getByText("$3.25")).toBeVisible();
  });

  it("offers all history when the period has no usage", async () => {
    const idle = { ...report.wisps[0], totals: { ...report.totals, inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    const getUsageReport = vi.fn(async () => ({
      ok: true,
      value: { ...report, period: "30d", wisps: [idle], totals: idle.totals },
    }));
    Object.defineProperty(window, "wisp", { configurable: true, value: { getUsageReport } });
    const user = userEvent.setup();
    render(<UsageSettingsSection />);
    expect(await screen.findByText("No usage in the last 30 days")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show all history" }));
    await waitFor(() => expect(getUsageReport).toHaveBeenLastCalledWith({ period: "all" }));
  });
});
