import { cn } from "@/lib/utils";
import type { SessionReportUsage } from "../../shared/contracts";

const TOKEN_KINDS = [
  { key: "inputTokens", label: "Input", color: "bg-chart-1" },
  { key: "outputTokens", label: "Output", color: "bg-chart-2" },
  { key: "cacheReadTokens", label: "Cache read", color: "bg-chart-3" },
  { key: "cacheWriteTokens", label: "Cache write", color: "bg-chart-4" },
] as const;

/**
 * A stacked bar of how the total splits into token kinds, with a legend carrying the same numbers.
 * `compact` keeps the legend in two columns, for narrow panels.
 */
export function TokenMix({ totals, compact = false }: { totals: SessionReportUsage; compact?: boolean }) {
  if (!totals.totalTokens) return null;
  const share = (value: number) => Math.round((value / totals.totalTokens) * 100);
  const parts = TOKEN_KINDS.map((kind) => ({ ...kind, value: totals[kind.key] }));
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
          compact ? "grid-cols-2" : "grid-cols-4 @max-[28rem]:grid-cols-2",
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
