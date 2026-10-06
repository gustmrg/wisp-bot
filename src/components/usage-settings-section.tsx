import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { SettingsCard, SettingsGroup, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { UsagePeriod, UsageReport } from "../../shared/contracts";

const PERIOD_OPTIONS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All history" },
];

export function UsageSettingsSection() {
  const [request, setRequest] = useState<{ period: UsagePeriod }>({ period: "30d" });
  // The previous report stays visible (dimmed) while the next one loads, so
  // switching periods or refreshing does not collapse the page.
  const [state, setState] = useState<{ report?: UsageReport; error?: string; loading: boolean }>({ loading: true });
  const [slide, setSlide] = useState<"animate-tab-forward" | "animate-tab-back">("animate-tab-forward");
  useEffect(() => {
    let active = true;
    setState((current) => ({ report: current.report, loading: true }));
    void window.wisp
      .getUsageReport(request)
      .then((result) => {
        if (active)
          setState(
            result.ok ? { report: result.value, loading: false } : { error: result.error.message, loading: false },
          );
      })
      .catch(() => {
        if (active) setState({ error: "Could not load token usage.", loading: false });
      });
    return () => {
      active = false;
    };
  }, [request]);
  const report = state.report;
  return (
    <section
      id="usage-settings-panel"
      aria-labelledby="usage-settings-title"
      className="min-w-0 overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
    >
      <h2 id="usage-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Token usage
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Tokens and estimated cost per Wisp, from saved session history on this device.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Period"
          value={request.period}
          options={PERIOD_OPTIONS}
          onChange={(period) => {
            const order = PERIOD_OPTIONS.map((option) => option.value);
            setSlide(
              order.indexOf(period) > order.indexOf(request.period) ? "animate-tab-forward" : "animate-tab-back",
            );
            setRequest({ period });
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={state.loading}
          onClick={() => setRequest((value) => ({ ...value }))}
        >
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {state.error}
        </p>
      ) : !report ? (
        <p role="status" className="mt-4 text-xs text-dim">
          Loading token usage…
        </p>
      ) : (
        <div
          key={report.period}
          aria-busy={state.loading || undefined}
          className={cn("transition-opacity duration-200", slide, state.loading && "opacity-60")}
        >
          <SettingsGroup label="Summary">
            <SettingsCard variant="stacked">
              <SettingsRow>
                <SettingsRowCopy>
                  <strong>Total tokens</strong>
                  <small>Input, output and cache tokens.</small>
                </SettingsRowCopy>
                <span className="text-md font-medium tabular-nums">
                  {report.totals.totalTokens.toLocaleString("en-US")}
                </span>
              </SettingsRow>
              <SettingsRow>
                <SettingsRowCopy>
                  <strong>Estimated cost</strong>
                  <small>In USD, from the latest available model prices.</small>
                </SettingsRowCopy>
                <span className="text-md font-medium tabular-nums">{cost(report.totals.costUsd)}</span>
              </SettingsRow>
            </SettingsCard>
          </SettingsGroup>
          {report.incomplete ? (
            <p role="alert" className="mx-0.5 mt-[7px] text-xs text-destructive">
              Some session history could not be read. Token totals are partial; cost is unknown.
            </p>
          ) : null}
          <SettingsGroup label="By Wisp">
            {report.wisps.length === 0 ? (
              <p className="mx-0.5 text-xs text-dim">No Wisps yet. Usage will appear after you send messages.</p>
            ) : (
              <SettingsCard className="overflow-x-auto">
                <table className="w-full text-left text-xs tabular-nums">
                  <caption className="sr-only">Token usage and estimated USD by Wisp</caption>
                  <thead>
                    <tr className="text-dim">
                      {["Wisp", "Input", "Output", "Cache read / write", "Total", "Est. USD"].map((heading) => (
                        <th scope="col" key={heading} className="border-b border-border px-3 py-2 font-normal">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="[&>tr:not(:last-child)>*]:border-b [&>tr>*]:border-border">
                    {report.wisps.map((wisp) => (
                      <tr key={wisp.conversationId}>
                        <th scope="row" className="max-w-36 break-words px-3 py-2.5 text-sm font-medium">
                          {wisp.name}
                          <span className="block text-xs font-normal text-dim">{wisp.sessions} sessions</span>
                        </th>
                        <td className="px-3">{wisp.totals.inputTokens.toLocaleString("en-US")}</td>
                        <td className="px-3">{wisp.totals.outputTokens.toLocaleString("en-US")}</td>
                        <td className="px-3">
                          {wisp.totals.cacheReadTokens.toLocaleString("en-US")} /{" "}
                          {wisp.totals.cacheWriteTokens.toLocaleString("en-US")}
                        </td>
                        <td className="px-3">{wisp.totals.totalTokens.toLocaleString("en-US")}</td>
                        <td className="whitespace-nowrap px-3">{cost(wisp.totals.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SettingsCard>
            )}
          </SettingsGroup>
          <div className="mx-0.5 mt-4 flex flex-col gap-2 text-xs leading-[1.45] text-dim">
            <p className="m-0">
              Estimates use the latest available OpenRouter model prices, including cache tokens, or the cost recorded
              with each turn for other providers. Provider routing and other charges may differ from your bill. Unknown
              means pricing or history is unavailable.
            </p>
            <p className="m-0">
              Prices updated:{" "}
              {report.pricingUpdatedAt ? new Date(report.pricingUpdatedAt).toLocaleString() : "Unavailable"}. History
              includes saved sessions for existing Wisps, across app restarts.
            </p>
            <p className="m-0">
              {report.from ? `${new Date(report.from).toLocaleString()} – ` : "All history through "}
              {new Date(report.generatedAt).toLocaleString()}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function cost(value: number | null): string {
  return value === null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
}
