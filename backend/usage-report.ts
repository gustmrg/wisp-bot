import type {
  ModelUsageRow,
  UsageReport,
  UsageReportRequest,
  WispUsageRow,
  WispSessionReport,
} from "../shared/contracts.js";
import { emptyUsage } from "./pi-session-report.js";

export function usagePeriodStart(period: UsageReportRequest["period"], now: Date): string | null {
  return period === "all" ? null : new Date(now.getTime() - (period === "7d" ? 7 : 30) * 86_400_000).toISOString();
}

export function addTotals(target: WispUsageRow["totals"], source: WispSessionReport["totals"]): void {
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
    target[key] += source[key];
  }
  target.costUsd = target.costUsd === null || source.costUsd === null ? null : target.costUsd + source.costUsd;
  target.cacheSavingsUsd =
    target.cacheSavingsUsd === null || source.cacheSavingsUsd === null
      ? null
      : target.cacheSavingsUsd + source.cacheSavingsUsd;
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
    totals: { ...emptyUsage(), costUsd: 0, cacheSavingsUsd: 0 },
  };
}

/** Usage split by model, keyed by `ModelUsageRow.key`. */
export type ModelUsage = Map<string, ModelUsageRow>;

/**
 * Adds a session's usage to `models`, one row per model. A model is one row whether it
 * answered turns or ran as an auxiliary model; turns a Claude plan paid for are a row of
 * their own. Context summaries, whose model is not recorded, are a `compaction` row, so
 * the rows add up to the session's totals.
 */
export function addModelUsage(models: ModelUsage, session: WispSessionReport): void {
  for (const model of session.models) {
    const key = `${model.plan ? "plan:" : ""}${model.providerId}:${model.modelId}`;
    const row = modelRow(models, key, () => ({
      kind: "model",
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.plan ? { plan: true as const } : {}),
    }));
    row.turns += model.turns;
    if (model.auxiliary?.task === "decision") row.decisionCalls = (row.decisionCalls ?? 0) + model.auxiliary.calls;
    else row.auxiliaryCalls += model.auxiliary?.calls ?? 0;
    addTotals(row.totals, {
      ...model.usage,
      costUsd: model.costUsd,
      cacheSavingsUsd: model.cacheSavingsUsd ?? null,
    });
  }
  const compaction = session.compactionUsage;
  if (compaction && compaction.totalTokens > 0) {
    const row = modelRow(models, "compaction", () => ({ kind: "compaction", providerId: null, modelId: null }));
    // Cache savings leave compaction out, like the session's own.
    addTotals(row.totals, { ...compaction, costUsd: session.compactionCostUsd ?? null, cacheSavingsUsd: 0 });
  }
}

/** Adds one usage split into another, as the report adds up its Wisps. */
export function mergeModelUsage(target: ModelUsage, source: Iterable<ModelUsageRow>): void {
  for (const other of source) {
    const row = modelRow(target, other.key, () => ({
      kind: other.kind,
      providerId: other.providerId,
      modelId: other.modelId,
      ...(other.plan ? { plan: true as const } : {}),
    }));
    row.turns += other.turns;
    row.auxiliaryCalls += other.auxiliaryCalls;
    if (other.decisionCalls) row.decisionCalls = (row.decisionCalls ?? 0) + other.decisionCalls;
    addTotals(row.totals, other.totals);
  }
}

function modelRow(
  models: ModelUsage,
  key: string,
  identity: () => Pick<ModelUsageRow, "kind" | "providerId" | "modelId" | "plan">,
): ModelUsageRow {
  let row = models.get(key);
  if (!row) {
    row = {
      key,
      ...identity(),
      turns: 0,
      auxiliaryCalls: 0,
      totals: { ...emptyUsage(), costUsd: 0, cacheSavingsUsd: 0 },
    };
    models.set(key, row);
  }
  return row;
}
