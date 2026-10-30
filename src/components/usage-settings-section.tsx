import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChartColumnIcon, CircleAlertIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Wisp } from "@/components/wisp";
import { SettingsCard, SettingsGroup } from "@/components/settings/settings-primitives";
import {
  CacheStats,
  formatUsd,
  inputSplit,
  plural,
  shortModelId,
  TokenCount,
  TokenMix,
} from "@/components/usage-display";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTimeZone } from "@/hooks/use-time-zone";
import type { WispOption } from "@/lib/plugin-access";
import { cn } from "@/lib/utils";
import type { ModelUsageRow, UsagePeriod, UsageReport, WispUsageRow } from "../../shared/contracts";

const PERIOD_OPTIONS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All history" },
];

type Totals = WispUsageRow["totals"];
type Breakdown = "wisp" | "model";

const BREAKDOWN_OPTIONS: ReadonlyArray<{ value: Breakdown; label: string }> = [
  { value: "wisp", label: "By Wisp" },
  { value: "model", label: "By model" },
];
const ALL_MODELS = "all";

export function UsageSettingsSection({ wisps = [] }: { wisps?: ReadonlyArray<WispOption> }) {
  return (
    <section
      id="usage-settings-panel"
      aria-labelledby="usage-settings-title"
      className="@container min-w-0 overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
    >
      <h2 id="usage-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Token usage
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Tokens and estimated cost per Wisp and per model, from saved session history on this device.
      </p>
      <UsageReportPanel wisps={wisps} />
    </section>
  );
}

interface UsageReportPanelProps {
  wisps?: ReadonlyArray<WispOption>;
  /** A circle whose members' usage in it is shown, rather than every Wisp's everywhere. */
  conversationId?: string;
  /** Loads again each time it becomes active. */
  active?: boolean;
}

/**
 * Token usage by Wisp or by model, for a period: every Wisp's, or only what a circle's members
 * used in it. Choosing a model narrows the summary and the table to that model's usage.
 */
export function UsageReportPanel({ wisps = [], conversationId, active = true }: UsageReportPanelProps) {
  const [request, setRequest] = useState<{ period: UsagePeriod }>({ period: "30d" });
  const timeZone = useTimeZone();
  // The previous report stays visible (dimmed) while the next one loads, so
  // switching periods or refreshing does not collapse the page.
  const [state, setState] = useState<{ report?: UsageReport; error?: string; loading: boolean }>({ loading: true });
  const [slide, setSlide] = useState<"animate-tab-forward" | "animate-tab-back">("animate-tab-forward");
  const [breakdown, setBreakdown] = useState<Breakdown>("wisp");
  const [modelKey, setModelKey] = useState(ALL_MODELS);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setState((value) => ({ report: value.report, loading: true }));
    void window.wisp
      .getUsageReport(conversationId ? { ...request, conversationId } : request)
      .then((result) => {
        if (current)
          setState(
            result.ok ? { report: result.value, loading: false } : { error: result.error.message, loading: false },
          );
      })
      .catch(() => {
        if (current) setState({ error: "Could not load token usage.", loading: false });
      });
    return () => {
      current = false;
    };
  }, [request, conversationId, active]);
  const changePeriod = (period: UsagePeriod) => {
    const order = PERIOD_OPTIONS.map((option) => option.value);
    setSlide(order.indexOf(period) > order.indexOf(request.period) ? "animate-tab-forward" : "animate-tab-back");
    setRequest({ period });
  };
  const refresh = () => setRequest((value) => ({ ...value }));
  const fullReport = state.report;
  // Servers older than the split send no models; the page then stays by Wisp.
  const models = fullReport?.models;
  const model = models?.find((row) => row.key === modelKey);
  const report = fullReport && model ? forModel(fullReport, model) : fullReport;
  const wispsById = new Map(wisps.map((wisp) => [wisp.id, wisp]));
  const circle = conversationId !== undefined;
  return (
    <div className="@container min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl label="Period" value={request.period} options={PERIOD_OPTIONS} onChange={changePeriod} />
        <div className="flex items-center gap-1.5">
          {models && models.length > 0 ? (
            <ModelFilter models={models} value={model ? model.key : ALL_MODELS} onChange={setModelKey} />
          ) : null}
          <Button size="sm" variant="ghost" disabled={state.loading} onClick={refresh}>
            <RefreshCwIcon aria-hidden="true" className={cn(state.loading && "motion-safe:animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>
      {state.error ? (
        <div role="alert" className="mt-4 flex gap-2.5 rounded-[10px] bg-popover p-3.5 text-xs leading-relaxed">
          <CircleAlertIcon aria-hidden="true" className="mt-px size-4 flex-none text-destructive" />
          <div className="space-y-2">
            <p className="m-0 font-semibold">{state.error}</p>
            <Button size="sm" variant="outline" onClick={refresh}>
              Try again
            </Button>
          </div>
        </div>
      ) : !report ? (
        <UsageSkeleton />
      ) : (
        <div
          key={report.period}
          aria-busy={state.loading || undefined}
          className={cn("transition-opacity duration-200", slide, state.loading && "opacity-60")}
        >
          {report.wisps.length === 0 ? (
            <EmptyUsage
              title={circle ? "No Wisps in this circle" : "No Wisps yet"}
              description="Usage will appear after you send messages."
            />
          ) : report.totals.totalTokens === 0 && !report.incomplete ? (
            <EmptyUsage
              title={
                report.period === "all"
                  ? "No usage yet"
                  : `No usage in the ${report.period === "7d" ? "last 7 days" : "last 30 days"}`
              }
              description={
                report.period === "all"
                  ? `Usage will appear after ${circle ? "this circle's" : "your"} Wisps reply to a message.`
                  : `Usage will appear after ${circle ? "this circle's" : "your"} Wisps reply to a message. Older sessions may show under All history.`
              }
              action={
                report.period === "all" ? null : (
                  <Button size="sm" variant="outline" onClick={() => changePeriod("all")}>
                    Show all history
                  </Button>
                )
              }
            />
          ) : (
            <>
              <UsageSummary report={report} model={model} />
              {report.incomplete ? (
                <div
                  role="status"
                  className="mt-3 flex gap-2.5 rounded-[10px] border border-warning-solid/40 bg-warning-solid/10 p-3 text-xs leading-relaxed text-warning"
                >
                  <TriangleAlertIcon aria-hidden="true" className="mt-px size-4 flex-none" />
                  <p className="m-0">
                    Some session history could not be read. Token totals are partial, and cost is unknown for the
                    affected Wisps.
                  </p>
                </div>
              ) : null}
              {models ? (
                <>
                  <div className="mx-0.5 mb-[7px] mt-[18px]">
                    <SegmentedControl<Breakdown>
                      label="Show usage"
                      value={breakdown}
                      options={BREAKDOWN_OPTIONS}
                      onChange={setBreakdown}
                    />
                  </div>
                  {breakdown === "model" ? (
                    <ModelTable
                      models={model ? [model] : models}
                      totals={report.totals}
                      wisps={fullReport?.wisps ?? []}
                    />
                  ) : (
                    <UsageTable report={report} wispsById={wispsById} model={model} />
                  )}
                </>
              ) : (
                <SettingsGroup label="By Wisp">
                  <UsageTable report={report} wispsById={wispsById} />
                </SettingsGroup>
              )}
            </>
          )}
          <details className="mx-0.5 mt-4 text-xs leading-[1.45] text-dim">
            <summary className="cursor-pointer">
              How the estimate works · Prices updated{" "}
              {report.pricingUpdatedAt
                ? new Date(report.pricingUpdatedAt).toLocaleString([], { timeZone })
                : "unavailable"}
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              <p className="m-0">
                Estimates use the latest available OpenRouter model prices, including cache tokens, or the cost recorded
                with each turn for other providers. Provider routing and other charges may differ from your bill.
                Unknown means pricing or history is unavailable.
              </p>
              <p className="m-0">
                Uncached input includes tokens written to the cache, which few providers report. Cache savings compare
                cached input with its full input price, less any extra charge for writing the cache.
              </p>
              <p className="m-0">
                {circle
                  ? "History includes the saved sessions of the circle's current members in this circle, across app restarts. Their usage elsewhere is not included."
                  : "History includes saved sessions for existing Wisps, across app restarts."}
              </p>
            </div>
          </details>
          <p className="mx-0.5 mb-0 mt-2 text-xs text-dim">
            {report.from ? `${new Date(report.from).toLocaleString([], { timeZone })} – ` : "All history through "}
            {new Date(report.generatedAt).toLocaleString([], { timeZone })}
          </p>
        </div>
      )}
    </div>
  );
}

function UsageSummary({ report, model }: { report: UsageReport; model?: ModelUsageRow }) {
  const { totals } = report;
  const unpriced = report.wisps.filter((wisp) => wisp.totals.costUsd === null).length;
  // With a Wisp missing prices the total is unknown; the priced part is still a floor worth showing.
  const pricedCost = report.wisps.reduce((sum, wisp) => sum + (wisp.totals.costUsd ?? 0), 0);
  const pricedSavings = report.wisps.reduce((sum, wisp) => sum + (wisp.totals.cacheSavingsUsd ?? 0), 0);
  const sessions = report.wisps.reduce((sum, wisp) => sum + wisp.sessions, 0);
  const active = report.wisps.filter((wisp) => wisp.totals.totalTokens > 0 && !wisp.decisionModel).length;
  return (
    <SettingsGroup label="Summary">
      <SettingsCard className="space-y-4 p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-0.5">
            <p className="m-0 text-xs text-dim">Estimated cost</p>
            <p className="m-0 text-[28px] font-semibold leading-tight tracking-tight tabular-nums">
              {totals.costUsd !== null
                ? formatUsd(totals.costUsd)
                : pricedCost > 0
                  ? `${formatUsd(pricedCost)}+`
                  : "Unknown"}
            </p>
            <p className="m-0 text-xs text-dim">
              {plural(active, "Wisp")} with usage · {model ? modelActivity(model) : plural(sessions, "session")}
            </p>
          </div>
          <dl className="m-0 @max-[28rem]:w-full @[28rem]:text-right">
            <dt className="text-xs text-dim">Processed tokens</dt>
            <dd className="m-0 text-xl font-semibold tabular-nums">
              <TokenCount value={totals.totalTokens} />
            </dd>
          </dl>
        </div>
        <TokenMix totals={totals} />
        <CacheStats totals={totals} pricedSavings={pricedSavings} />
        {totals.costUsd === null && unpriced > 0 && pricedCost > 0 ? (
          <p className="m-0 text-xs text-dim">
            Cost covers priced usage only. {plural(unpriced, "Wisp")} {unpriced === 1 ? "has" : "have"} an unknown cost.
          </p>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  );
}

function UsageTable({
  report,
  wispsById,
  model,
}: {
  report: UsageReport;
  wispsById: Map<string, WispOption>;
  /** The model the report is narrowed to: rows then count its turns rather than every session. */
  model?: ModelUsageRow;
}) {
  const rows = [...report.wisps].sort(
    (a, b) => (b.totals.costUsd ?? -1) - (a.totals.costUsd ?? -1) || b.totals.totalTokens - a.totals.totalTokens,
  );
  const topCost = Math.max(0, ...rows.map((row) => row.totals.costUsd ?? 0));
  return (
    <SettingsCard className="overflow-x-auto">
      {/* Below 35rem the rows stack into labelled cells; see .usage-table in styles.css. */}
      <table className="usage-table w-full text-right text-xs tabular-nums">
        <caption className="sr-only">
          Token usage and estimated USD by Wisp{model ? ` for ${modelLabel(model)}` : ""}
        </caption>
        <thead>
          <tr className="text-dim">
            {["Wisp", "Cached input", "Uncached input", "Output", "Total", "Est. USD"].map((heading) => (
              <th
                scope="col"
                key={heading}
                className="whitespace-nowrap border-b border-border px-3 py-2 font-normal first:text-left"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:not(:last-child)>*]:border-b [&>tr>*]:border-border">
          {rows.map((wisp) => {
            const option = wispsById.get(wisp.conversationId);
            return (
              <tr key={wisp.conversationId}>
                <th scope="row" className="max-w-44 px-3 py-2.5 text-left text-sm font-medium">
                  <span className="flex items-center gap-2">
                    <Wisp
                      aria-hidden="true"
                      className="flex-none"
                      appearance={option?.appearance}
                      color={option?.color}
                      name={wisp.name}
                      size="sm"
                    />
                    <span className="min-w-0 break-words">
                      {wisp.name}
                      <span className="block text-xs font-normal text-dim">
                        {model ? modelActivity(wispModel(wisp, model) ?? model) : plural(wisp.sessions, "session")}
                      </span>
                    </span>
                  </span>
                </th>
                <UsageCells totals={wisp.totals} topCost={topCost} />
              </tr>
            );
          })}
        </tbody>
        {rows.length > 1 ? (
          <tfoot className="font-semibold">
            <tr className="[&>*]:border-t [&>*]:border-border">
              <th scope="row" className="px-3 py-2.5 text-left text-sm">
                All Wisps
              </th>
              <UsageCells totals={report.totals} />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </SettingsCard>
  );
}

/** The report narrowed to one model: each Wisp's usage of it, and Wisps that never used it left out. */
function forModel(report: UsageReport, model: ModelUsageRow): UsageReport {
  return {
    ...report,
    wisps: report.wisps.flatMap((wisp) => {
      const row = wispModel(wisp, model);
      return row ? [{ ...wisp, totals: row.totals }] : [];
    }),
    totals: model.totals,
  };
}

function wispModel(wisp: WispUsageRow, model: ModelUsageRow): ModelUsageRow | undefined {
  return wisp.models?.find((row) => row.key === model.key);
}

function modelLabel(model: ModelUsageRow): string {
  if (model.kind === "compaction") return "Context summaries";
  return `${shortModelId(model.modelId ?? "")}${model.plan ? " (Claude plan)" : ""}`;
}

/** What a model did: turns it answered and calls it ran for a Wisp, or the summaries it wrote. */
function modelActivity(model: ModelUsageRow): string {
  if (model.kind === "compaction") return "summaries of long conversations";
  const parts = [
    ...(model.turns > 0 || (model.auxiliaryCalls === 0 && !model.decisionCalls) ? [plural(model.turns, "turn")] : []),
    ...(model.auxiliaryCalls > 0 ? [plural(model.auxiliaryCalls, "image read")] : []),
    ...(model.decisionCalls ? [plural(model.decisionCalls, "decision")] : []),
  ];
  return parts.join(" · ");
}

/**
 * Chooses one model, or all of them, in alphabetical order with context summaries last.
 * Two models with the same short name also show their provider.
 */
function ModelFilter({
  models,
  value,
  onChange,
}: {
  models: ReadonlyArray<ModelUsageRow>;
  value: string;
  onChange: (key: string) => void;
}) {
  const sorted = [...models].sort(
    (a, b) =>
      Number(a.kind === "compaction") - Number(b.kind === "compaction") || modelLabel(a).localeCompare(modelLabel(b)),
  );
  const labels = sorted.map(modelLabel);
  const items = [
    { value: ALL_MODELS, label: "All models" },
    ...sorted.map((model, index) => ({
      value: model.key,
      label:
        labels.indexOf(labels[index]!) === labels.lastIndexOf(labels[index]!)
          ? labels[index]!
          : `${labels[index]} · ${model.providerId}`,
    })),
  ];
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger aria-label="Model" size="sm" className="max-w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ModelTable({
  models,
  totals,
  wisps,
}: {
  models: ReadonlyArray<ModelUsageRow>;
  totals: Totals;
  wisps: ReadonlyArray<WispUsageRow>;
}) {
  const rows = [...models].sort(
    (a, b) => (b.totals.costUsd ?? -1) - (a.totals.costUsd ?? -1) || b.totals.totalTokens - a.totals.totalTokens,
  );
  const topCost = Math.max(0, ...rows.map((row) => row.totals.costUsd ?? 0));
  return (
    <SettingsCard className="overflow-x-auto">
      <table className="usage-table w-full text-right text-xs tabular-nums">
        <caption className="sr-only">Token usage and estimated USD by model</caption>
        <thead>
          <tr className="text-dim">
            {["Model", "Cached input", "Uncached input", "Output", "Total", "Est. USD"].map((heading) => (
              <th
                scope="col"
                key={heading}
                className="whitespace-nowrap border-b border-border px-3 py-2 font-normal first:text-left"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:not(:last-child)>*]:border-b [&>tr>*]:border-border">
          {rows.map((model) => {
            const users = wisps.filter((wisp) => !wisp.decisionModel && wispModel(wisp, model)).length;
            return (
              <tr key={model.key}>
                <th scope="row" className="max-w-52 px-3 py-2.5 text-left text-sm font-medium">
                  <span
                    className="block min-w-0 break-words"
                    title={model.kind === "model" ? `${model.providerId} · ${model.modelId}` : undefined}
                  >
                    {modelLabel(model)}
                    <span className="block text-xs font-normal text-dim">
                      {modelActivity(model)}
                      {users > 0 ? ` · ${plural(users, "Wisp")}` : ""}
                    </span>
                  </span>
                </th>
                <UsageCells totals={model.totals} topCost={topCost} />
              </tr>
            );
          })}
        </tbody>
        {rows.length > 1 ? (
          <tfoot className="font-semibold">
            <tr className="[&>*]:border-t [&>*]:border-border">
              <th scope="row" className="px-3 py-2.5 text-left text-sm">
                All models
              </th>
              <UsageCells totals={totals} />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </SettingsCard>
  );
}

function UsageCells({ totals, topCost }: { totals: Totals; topCost?: number }) {
  return (
    <>
      <td data-label="Cached input" className="px-3">
        <TokenCount value={inputSplit(totals).cached} />
      </td>
      <td data-label="Uncached input" className="px-3">
        <TokenCount value={inputSplit(totals).uncached} />
      </td>
      <td data-label="Output" className="px-3">
        <TokenCount value={totals.outputTokens} />
      </td>
      <td data-label="Total" className="px-3">
        <TokenCount value={totals.totalTokens} />
      </td>
      <td
        data-label="Est. USD"
        className={cn(
          "usage-cost whitespace-nowrap px-3 font-semibold",
          totals.costUsd === null && "font-normal text-dim",
        )}
      >
        {formatUsd(totals.costUsd)}
        {topCost && totals.costUsd !== null ? (
          <span aria-hidden="true" className="mt-1 ml-auto block h-[3px] w-full max-w-20 rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-chart-2"
              style={{ width: `${(totals.costUsd / topCost) * 100}%` }}
            />
          </span>
        ) : null}
      </td>
    </>
  );
}

function EmptyUsage({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <SettingsCard className="mt-4 flex flex-col items-center gap-1.5 px-5 py-8 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-full bg-muted text-dim">
        <ChartColumnIcon aria-hidden="true" className="size-[18px]" />
      </span>
      <p className="m-0 text-sm font-semibold">{title}</p>
      <p className="m-0 max-w-[36ch] text-xs text-dim">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </SettingsCard>
  );
}

function UsageSkeleton() {
  const bar = "rounded-md bg-muted motion-safe:animate-pulse";
  return (
    <>
      <p role="status" className="sr-only">
        Loading token usage…
      </p>
      <div aria-hidden="true">
        <SettingsCard className="mt-4 space-y-3 p-4">
          <div className={cn(bar, "h-2.5 w-24")} />
          <div className={cn(bar, "h-8 w-36")} />
          <div className={cn(bar, "h-3 w-full rounded-full")} />
        </SettingsCard>
        <SettingsCard className="mt-6 divide-y divide-border">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-2.5 px-3.5 py-3">
              <div className={cn(bar, "size-6 rounded-full")} />
              <div className={cn(bar, "h-2.5 w-32")} />
              <div className={cn(bar, "ml-auto h-2.5 w-14")} />
            </div>
          ))}
        </SettingsCard>
      </div>
    </>
  );
}
