import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsageSettingsSection } from "./usage-settings-section";
import type { UsageReport } from "../../shared/contracts";

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
      },
    },
  ],
};

describe("UsageSettingsSection", () => {
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
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Token totals are partial");
  });
});
