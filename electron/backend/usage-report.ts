import type { UsageReport, UsageReportRequest, WispUsageRow, WispSessionReport } from "../../shared/contracts.js";
import { emptyUsage } from "./pi-session-report.js";

export function usagePeriodStart(period: UsageReportRequest["period"], now: Date): string | null {
  return period === "all" ? null : new Date(now.getTime() - (period === "7d" ? 7 : 30) * 86_400_000).toISOString();
}

export function addTotals(target: WispUsageRow["totals"], source: WispSessionReport["totals"]): void {
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
    target[key] += source[key];
  }
  target.costUsd = target.costUsd === null || source.costUsd === null ? null : target.costUsd + source.costUsd;
}

export function createUsageReport(
  request: UsageReportRequest,
  now: Date,
  pricingUpdatedAt: string | null,
): UsageReport {
  return {
    generatedAt: now.toISOString(),
    from: usagePeriodStart(request.period, now),
    period: request.period,
    pricingUpdatedAt,
    incomplete: false,
    wisps: [],
    totals: { ...emptyUsage(), costUsd: 0 },
  };
}
