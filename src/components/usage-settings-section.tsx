import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { UsagePeriod, UsageReport } from "../../shared/contracts";

export function UsageSettingsSection() {
  const [request, setRequest] = useState<{ period: UsagePeriod }>({ period: "30d" });
  const [state, setState] = useState<{ report?: UsageReport; error?: string }>({});
  useEffect(() => {
    let active = true;
    setState({});
    void window.wisp
      .getUsageReport(request)
      .then((result) => {
        if (active) setState(result.ok ? { report: result.value } : { error: result.error.message });
      })
      .catch(() => {
        if (active) setState({ error: "Could not load token usage." });
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
      className="min-w-0 overflow-y-auto px-[30px] py-6 max-[620px]:px-4"
    >
      <h2 id="usage-settings-title" className="mb-4 text-[17px]">
        Token usage
      </h2>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="usage-period" className="text-xs">
          Period
        </label>
        <select
          id="usage-period"
          value={request.period}
          onChange={(event) => setRequest({ period: event.target.value as UsagePeriod })}
          className="rounded border border-border bg-background p-2 text-xs"
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All history</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          disabled={!report && !state.error}
          onClick={() => setRequest((value) => ({ ...value }))}
        >
          Refresh
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : !report ? (
        <p role="status" className="text-sm text-dim">
          Loading token usage…
        </p>
      ) : (
        <>
          <div className="mb-4 rounded-lg border border-border p-4">
            <p className="text-xs text-dim">Total tokens</p>
            <p className="text-2xl tabular-nums">{report.totals.totalTokens.toLocaleString("en-US")}</p>
            <p className="mt-2 text-sm">{cost(report.totals.costUsd)} estimated USD</p>
          </div>
          {report.incomplete ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              Some session history could not be read. Token totals are partial; cost is unknown.
            </p>
          ) : null}
          {report.wisps.length === 0 ? (
            <p className="text-sm text-dim">No Wisps yet. Usage will appear after you send messages.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs tabular-nums">
                <caption className="sr-only">Token usage and estimated USD by Wisp</caption>
                <thead>
                  <tr>
                    {["Wisp", "Input", "Output", "Cache read / write", "Total", "Est. USD"].map((heading) => (
                      <th scope="col" key={heading} className="border-b border-border px-2 py-2 font-medium">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.wisps.map((wisp) => (
                    <tr key={wisp.conversationId}>
                      <th scope="row" className="max-w-36 break-words border-b border-border px-2 py-3 font-medium">
                        {wisp.name}
                        <span className="block font-normal text-dim">{wisp.sessions} sessions</span>
                      </th>
                      <td className="px-2">{wisp.totals.inputTokens.toLocaleString("en-US")}</td>
                      <td className="px-2">{wisp.totals.outputTokens.toLocaleString("en-US")}</td>
                      <td className="px-2">
                        {wisp.totals.cacheReadTokens.toLocaleString("en-US")} /{" "}
                        {wisp.totals.cacheWriteTokens.toLocaleString("en-US")}
                      </td>
                      <td className="px-2">{wisp.totals.totalTokens.toLocaleString("en-US")}</td>
                      <td className="whitespace-nowrap px-2">{cost(wisp.totals.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs leading-relaxed text-dim">
            Estimates use the latest available OpenRouter model prices, including cache tokens. Provider routing and
            other charges may differ from your bill. Unknown means pricing or history is unavailable.
          </p>
          <p className="mt-2 text-xs text-dim">
            Prices updated:{" "}
            {report.pricingUpdatedAt ? new Date(report.pricingUpdatedAt).toLocaleString() : "Unavailable"}. History
            includes saved sessions for existing Wisps, across app restarts.
          </p>
          <p className="mt-2 text-xs text-dim">
            {report.from ? `${new Date(report.from).toLocaleString()} – ` : "All history through "}
            {new Date(report.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </section>
  );
}

function cost(value: number | null): string {
  return value === null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
}
