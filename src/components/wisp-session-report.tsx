import { useCallback, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import type { WispSessionReport } from "../../shared/contracts";
import { SettingsCard } from "@/components/settings/settings-primitives";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

interface WispSessionReportSectionProps {
  chatId: string;
}

type ReportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; report: WispSessionReport | null }
  | { status: "error"; message: string };

export function WispSessionReportSection({ chatId }: WispSessionReportSectionProps) {
  const [state, setState] = useState<ReportState>({ status: "idle" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const result = await window.wisp.getSessionReport({ conversationId: chatId });
      if (!result.ok) {
        setState({ status: "error", message: result.error.message });
        return;
      }
      setState({ status: "ready", report: result.value });
    } catch {
      setState({ status: "error", message: "Could not load the session report." });
    }
  }, [chatId]);

  return (
    <SettingsCard className="mt-[15px]">
      <Accordion>
        <AccordionItem
          className="border-b-0"
          onOpenChange={(open) => {
            if (open) void load();
          }}
        >
          <AccordionTrigger className="gap-3 py-[11px] font-normal">
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <strong className="text-left text-[12.5px]">Session activity</strong>
              <small className="text-left text-[11px] leading-[1.3]">
                Tool calls, token usage, and model data for this Wisp
              </small>
            </span>
          </AccordionTrigger>
          <AccordionContent className="px-0 pb-3.5 text-sm">
            <SessionReportContent state={state} onRefresh={() => void load()} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </SettingsCard>
  );
}

function SessionReportContent({ state, onRefresh }: { state: ReportState; onRefresh: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <p className="px-3.5 text-dim" role="status">
        Loading session activity…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div className="px-3.5">
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
        <RefreshButton onRefresh={onRefresh} />
      </div>
    );
  }
  if (!state.report) {
    return (
      <p className="px-3.5 text-dim" role="status">
        No agent session yet. Configure a model and send a message to create one.
      </p>
    );
  }
  const { report } = state;
  return (
    <div className="flex flex-col gap-3 px-3.5">
      <dl className="flex flex-col gap-1.5 text-[11.5px]">
        <SummaryTerm label="Session" value={report.sessionId} />
        {report.piVersion ? <SummaryTerm label="Pi version" value={report.piVersion} /> : null}
        <SummaryTerm label="Turns" value={String(report.turns)} />
        <SummaryTerm
          label="Tokens"
          value={`${formatTokenCount(report.totals.inputTokens)} in · ${formatTokenCount(
            report.totals.outputTokens,
          )} out · ${formatTokenCount(report.totals.totalTokens)} total`}
        />
        <SummaryTerm
          label="Estimated cost"
          value={
            report.totals.costUsd === null ? "Unknown (no pricing for a model used)" : formatCost(report.totals.costUsd)
          }
        />
      </dl>
      <p className="text-[11px] text-dim">
        Argument text and provider error details are hidden for privacy. Latest 50 tool calls and events.
      </p>
      <ModelList report={report} />
      <ToolCallList report={report} />
      <EventList report={report} />
      <RefreshButton onRefresh={onRefresh} />
    </div>
  );
}

function ModelList({ report }: { report: WispSessionReport }) {
  if (report.models.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-[11px] text-dim">Models</h4>
      <ul className="flex flex-col gap-1 text-[11.5px]">
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
  return (
    <div>
      <h4 className="mb-1 text-[11px] text-dim">Tool calls</h4>
      {report.toolCalls.length === 0 ? (
        <p className="text-[11.5px] text-dim">No tool calls recorded.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-[11.5px]">
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
                <span className="ml-auto shrink-0 text-dim">{formatTimestamp(toolCall.timestamp)}</span>
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
  if (report.events.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-[11px] text-dim">Events</h4>
      <ul className="flex flex-col gap-1 text-[11.5px]">
        {report.events.map((event, index) => (
          <li key={`${event.kind}:${event.timestamp}:${index}`} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <span className={event.kind === "error" ? "text-destructive" : "text-foreground"}>
                {event.kind === "error" ? "Error" : event.kind === "compaction" ? "Compaction" : "Retry"}
              </span>
              <span className="ml-auto shrink-0 text-dim">{formatTimestamp(event.timestamp)}</span>
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
    <Button
      className="self-start text-[11.5px]"
      size="sm"
      type="button"
      variant="ghost"
      onClick={onRefresh}
      disabled={false}
    >
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

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
