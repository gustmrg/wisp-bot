import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import type { WispSessionReport } from "../../shared/contracts";
import { SettingsCard } from "@/components/settings/settings-primitives";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { useTimeZone } from "@/hooks/use-time-zone";

interface WispSessionReportSectionProps {
  chatId: string;
  active?: boolean;
}

type ReportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; report: WispSessionReport | null }
  | { status: "error"; message: string };

export function WispSessionReportSection({ chatId, active = true }: WispSessionReportSectionProps) {
  const [state, setState] = useState<ReportState>({ status: "idle" });
  const [request, setRequest] = useState({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState({ status: "loading" });
    void window.wisp
      .getSessionReport({ ...request, conversationId: chatId })
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok ? { status: "ready", report: result.value } : { status: "error", message: result.error.message },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "Could not load the session report." });
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, active, request]);
  return <SessionReportContent state={state} onRefresh={() => setRequest({})} />;
}

function SessionReportContent({ state, onRefresh }: { state: ReportState; onRefresh: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <p className="text-dim" role="status">
        Loading session activity…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div className="">
        <p className="text-base text-destructive" role="alert">
          {state.message}
        </p>
        <RefreshButton onRefresh={onRefresh} />
      </div>
    );
  }
  if (!state.report) {
    return (
      <p className="text-dim" role="status">
        No agent session yet. Configure a model and send a message to create one.
      </p>
    );
  }
  const { report } = state;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <SettingsCard className="p-3">
          <p className="text-xs text-dim">Total tokens</p>
          <p className="mt-1 text-xl font-medium tabular-nums">{formatTokenCount(report.totals.totalTokens)}</p>
        </SettingsCard>
        <SettingsCard className="p-3">
          <p className="text-xs text-dim">Estimated USD</p>
          <p className="mt-1 break-all text-xl font-medium tabular-nums">
            {report.totals.costUsd === null ? "Unknown" : formatCost(report.totals.costUsd)}
          </p>
        </SettingsCard>
      </div>
      <dl className="flex flex-col gap-1.5 text-xs">
        <SummaryTerm label="Input" value={formatTokenCount(report.totals.inputTokens)} />
        <SummaryTerm label="Output" value={formatTokenCount(report.totals.outputTokens)} />
        <SummaryTerm
          label="Cache read / write"
          value={`${formatTokenCount(report.totals.cacheReadTokens)} / ${formatTokenCount(report.totals.cacheWriteTokens)}`}
        />
      </dl>
      <p className="text-xs leading-relaxed text-dim">
        Usage for this session. Costs are estimates based on available model prices.
        {report.totals.costUsd === null ? " Pricing is unavailable for one or more models." : ""}
      </p>
      {report.compactionUsage?.totalTokens ? (
        <p className="text-sm text-dim">
          Includes {report.compactionUsage.totalTokens.toLocaleString()} tokens used to summarize context. Summary costs
          use the runtime's recorded estimate.
        </p>
      ) : null}
      <Accordion>
        <AccordionItem>
          <AccordionTrigger>Session details</AccordionTrigger>
          <AccordionContent>
            <dl className="mb-3 flex flex-col gap-1.5 text-xs">
              <SummaryTerm label="Session" value={report.sessionId} />
              {report.piVersion ? <SummaryTerm label="Pi version" value={report.piVersion} /> : null}
              <SummaryTerm label="Turns" value={String(report.turns)} />
            </dl>
            <ModelList report={report} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem>
          <AccordionTrigger>Tool calls ({report.toolCalls.length})</AccordionTrigger>
          <AccordionContent>
            <ToolCallList report={report} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem>
          <AccordionTrigger>Events ({report.events.length})</AccordionTrigger>
          <AccordionContent>
            {report.events.length ? (
              <EventList report={report} />
            ) : (
              <p className="text-sm text-dim">No events recorded.</p>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <p className="text-xs text-dim">
        Argument text and provider error details are hidden for privacy. Latest 50 tool calls and events.
      </p>
      <RefreshButton onRefresh={onRefresh} />
    </div>
  );
}

function ModelList({ report }: { report: WispSessionReport }) {
  if (report.models.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs text-dim">Models</h4>
      <ul className="flex flex-col gap-1 text-xs">
        {report.models.map((model) => (
          <li key={`${model.providerId}:${model.modelId}`} className="flex flex-wrap gap-1.5">
            <span className="min-w-0 break-all">
              {model.modelId} · {model.turns} {model.turns === 1 ? "turn" : "turns"}
            </span>
            <span className="text-dim">
              {model.costUsd === null ? "cost unknown" : `${formatCost(model.costUsd)} est.`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolCallList({ report }: { report: WispSessionReport }) {
  const timeZone = useTimeZone();
  return (
    <div>
      <h4 className="mb-1 text-xs text-dim">Tool calls</h4>
      {report.toolCalls.length === 0 ? (
        <p className="text-xs text-dim">No tool calls recorded.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {report.toolCalls.map((toolCall) => (
            <li key={toolCall.toolCallId} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span
                  className={
                    toolCall.status === "error"
                      ? "text-destructive"
                      : toolCall.status === "pending"
                        ? "text-dim"
                        : "text-foreground"
                  }
                >
                  {toolCall.status === "error" ? "✗" : toolCall.status === "pending" ? "…" : "✓"}
                </span>
                <span className="min-w-0 break-all">{toolCall.toolName}</span>
                <span className="ml-auto shrink-0 text-dim">{formatTimestamp(toolCall.timestamp, timeZone)}</span>
              </span>
              {toolCall.argumentSummary ? (
                <span className="ml-4 break-all text-dim">{toolCall.argumentSummary}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventList({ report }: { report: WispSessionReport }) {
  const timeZone = useTimeZone();
  if (report.events.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs text-dim">Events</h4>
      <ul className="flex flex-col gap-1 text-xs">
        {report.events.map((event, index) => (
          <li key={`${event.kind}:${event.timestamp}:${index}`} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className={event.kind === "error" ? "text-destructive" : "text-foreground"}>
                {event.kind === "error" ? "Error" : event.kind === "compaction" ? "Compaction" : "Retry"}
              </span>
              <span className="ml-auto shrink-0 text-dim">{formatTimestamp(event.timestamp, timeZone)}</span>
            </span>
            <span className="break-all text-dim">{event.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefreshButton({ onRefresh }: { onRefresh: () => void }) {
  return (
    <Button className="self-start text-xs" size="sm" type="button" variant="ghost" onClick={onRefresh} disabled={false}>
      <RefreshCwIcon data-icon="inline-start" />
      Refresh
    </Button>
  );
}

function SummaryTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-dim">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  );
}

function formatTokenCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "0";
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function formatTimestamp(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}
