import { cn } from "@/lib/utils";
import type { SessionReportTotals, SessionReportUsage } from "../../shared/contracts";

/**
 * Input split by whether it came from the provider's cache. Few providers
 * report cache writes, so a write counts as uncached input: it was processed in full.
 */
export function inputSplit(totals: SessionReportUsage): { cached: number; uncached: number } {
  return { cached: totals.cacheReadTokens, uncached: totals.inputTokens + totals.cacheWriteTokens };
}

/** The share of input served from cache, or null with no input. */
export function cacheHitRate(totals: SessionReportUsage): number | null {
  const { cached, uncached } = inputSplit(totals);
  return cached + uncached > 0 ? cached / (cached + uncached) : null;
}

function tokenParts(totals: SessionReportUsage) {
  const { cached, uncached } = inputSplit(totals);
  return [
    { key: "cached", label: "Cached input", color: "bg-chart-3", value: cached },
    { key: "uncached", label: "Uncached input", color: "bg-chart-1", value: uncached },
    { key: "output", label: "Output", color: "bg-chart-2", value: totals.outputTokens },
  ];
}

/**
 * A stacked bar of how the total splits into token kinds, with a legend carrying the same numbers.
 * `compact` keeps the legend in two columns, for narrow panels.
 */
export function TokenMix({ totals, compact = false }: { totals: SessionReportUsage; compact?: boolean }) {
  if (!totals.totalTokens) return null;
  const share = (value: number) => Math.round((value / totals.totalTokens) * 100);
  const parts = tokenParts(totals);
  return (
    <div className="space-y-2.5">
      <div
        role="img"
        aria-label={`Token mix: ${parts.map((part) => `${part.label} ${share(part.value)}%`).join(", ")}`}
        className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted"
      >
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <div
              key={part.key}
              className={cn("h-full min-w-0.5", part.color)}
              style={{ width: `${(part.value / totals.totalTokens) * 100}%` }}
            />
          ))}
      </div>
      <ul
        className={cn(
          "m-0 grid list-none gap-x-4 gap-y-2 p-0 text-xs",
          compact ? "grid-cols-2" : "grid-cols-3 @max-[28rem]:grid-cols-2",
        )}
      >
        {parts.map((part) => (
          <li
            key={part.key}
            className={cn("flex min-w-0", compact ? "items-center justify-between gap-2" : "flex-col")}
          >
            <span className="flex items-center gap-1.5 text-dim">
              <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", part.color)} />
              {part.label}
            </span>
            <span className={cn("font-medium tabular-nums", !compact && "pl-4")}>
              <TokenCount value={part.value} />
              {compact ? null : ` · ${share(part.value)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * How much of the input came from cache, and what that saved. `pricedSavings`
 * is shown as a floor ("$1.20+") when part of the savings is unknown.
 */
export function CacheStats({
  totals,
  pricedSavings = 0,
  compact = false,
}: {
  totals: SessionReportTotals;
  pricedSavings?: number;
  compact?: boolean;
}) {
  const hitRate = cacheHitRate(totals);
  if (hitRate === null) return null;
  return (
    <dl className={cn("m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-xs", !compact && "@[28rem]:max-w-80")}>
      <div className="flex min-w-0 flex-col">
        <dt className="text-dim">Cache hit rate</dt>
        <dd className="m-0 font-medium tabular-nums">{formatPercent(hitRate)}</dd>
      </div>
      <div className="flex min-w-0 flex-col">
        <dt className="text-dim">Cache savings</dt>
        <dd className={cn("m-0 font-medium tabular-nums", totals.cacheSavingsUsd === null && "font-normal text-dim")}>
          {totals.cacheSavingsUsd === null && pricedSavings > 0
            ? `${formatUsd(pricedSavings)}+`
            : formatUsd(totals.cacheSavingsUsd)}
        </dd>
      </div>
    </dl>
  );
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

/** A token count shortened for reading (12.4M), with the exact count for screen readers and on hover. */
export function TokenCount({ value }: { value: number }) {
  const full = value.toLocaleString("en-US");
  return (
    <span title={`${full} tokens`}>
      <span aria-hidden="true">{compactNumber(value)}</span>
      <span className="sr-only">{full}</span>
    </span>
  );
}

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value < 1000
    ? String(value)
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(value);
}

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** An estimated cost in USD, rounded to cents; amounts under a cent read "<$0.01". */
export function formatUsd(value: number | null): string {
  if (value === null) return "Unknown";
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}
