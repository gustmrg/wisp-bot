import { type ReactNode, useEffect, useState } from "react";
import {
  ChartColumnIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import type { SessionReportToolCall, WispSessionReport } from "../../shared/contracts";
import { SettingsCard, SettingsGroup } from "@/components/settings/settings-primitives";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { CacheStats, formatUsd, plural, TokenCount, TokenMix } from "@/components/usage-display";
import { useTimeFormat, useTimeZone } from "@/hooks/use-time-zone";
import { clockTimeOptions, type TimeFormat } from "@/lib/clock-time";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { cn } from "@/lib/utils";

interface WispSessionReportSectionProps {
  chatId: string;
  active?: boolean;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}

/** Tool names offered as filters, besides All and Failed. */
const TOOL_FILTERS_SHOWN = 3;

// The last report stays visible (dimmed) while the next one loads, so refreshing does not collapse the tab.
type ReportState =
  | { status: "idle" }
  | { status: "loading"; report?: WispSessionReport | null }
  | { status: "ready"; report: WispSessionReport | null }
  | { status: "error"; message: string };

export function WispSessionReportSection({ chatId, active = true, onOpenSettings }: WispSessionReportSectionProps) {
  const [state, setState] = useState<ReportState>({ status: "idle" });
  const [request, setRequest] = useState({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState((current) => ({ status: "loading", report: "report" in current ? current.report : undefined }));
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
  return <SessionReportContent state={state} onRefresh={() => setRequest({})} onOpenSettings={onOpenSettings} />;
}

function SessionReportContent({
  state,
  onRefresh,
  onOpenSettings,
}: {
  state: ReportState;
  onRefresh: () => void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  if (state.status === "idle") return null;
  if (state.status === "error") {
    return (
      <div role="alert" className="flex gap-2.5 rounded-[10px] bg-popover p-3 text-xs leading-relaxed">
        <CircleAlertIcon aria-hidden="true" className="mt-px size-4 flex-none text-destructive" />
        <div className="space-y-2">
          <p className="m-0 font-semibold">{state.message}</p>
          <Button size="sm" variant="outline" type="button" onClick={onRefresh}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (state.status === "loading" && state.report === undefined) return <ReportSkeleton />;
  const report = state.report;
  if (!report) {
    return (
      <SettingsCard className="flex flex-col items-center gap-1.5 px-5 py-7 text-center">
        <span className="mb-1 grid size-10 place-items-center rounded-full bg-muted text-dim">
          <ChartColumnIcon aria-hidden="true" className="size-[18px]" />
        </span>
        <p role="status" className="m-0 text-sm font-semibold">
          No session yet
        </p>
        <p className="m-0 max-w-[34ch] text-xs text-dim">
          Usage appears here after this Wisp replies for the first time. Configure a model and send a message to start
          one.
        </p>
      </SettingsCard>
    );
  }
  const loading = state.status === "loading";
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-xs text-dim">Current session · {plural(report.turns, "turn")}</p>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          className="-my-1 text-xs"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCwIcon aria-hidden="true" className={cn(loading && "motion-safe:animate-spin")} />
          Refresh
        </Button>
      </div>
      <div
        aria-busy={loading || undefined}
        className={cn("flex flex-col gap-3.5 transition-opacity duration-200", loading && "opacity-60")}
      >
        <SessionSummary report={report} />
        <ModelList report={report} />
        <IncludedUsage report={report} />
        <Accordion multiple className="border-y border-border">
          <AccordionItem>
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-1.5">
                Tool calls
                <CountBadge>{report.toolCalls.length}</CountBadge>
                <FailedBadge count={report.toolCalls.filter((call) => call.status === "error").length} />
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <ToolCallList toolCalls={report.toolCalls} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem>
            <AccordionTrigger className="text-sm">
              <span className="flex items-center gap-1.5">
                Events
                <CountBadge>{report.events.length}</CountBadge>
                <FailedBadge count={report.events.filter((event) => event.kind === "error").length} noun="error" />
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <EventList report={report} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem>
            <AccordionTrigger className="text-sm">Session details</AccordionTrigger>
            <AccordionContent>
              <SessionDetails report={report} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <p className="m-0 text-xs leading-relaxed text-dim">
          Costs are estimates based on available model prices. Argument text and provider error details are hidden for
          privacy; commands show only the programs they ran. Shows the latest 50 tool calls and events.
        </p>
        {onOpenSettings ? (
          <Button
            variant="link"
            size="xs"
            type="button"
            className="h-auto self-start p-0"
            onClick={() => onOpenSettings({ section: "usage" })}
          >
            Compare with other Wisps in Token usage
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SessionSummary({ report }: { report: WispSessionReport }) {
  const unpriced = report.models.filter((model) => model.costUsd === null);
  return (
    <>
      <SettingsCard className="space-y-3 p-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="m-0 text-xs text-dim">Estimated cost</p>
            <p className="m-0 text-[26px] font-semibold leading-tight tracking-tight tabular-nums">
              {formatUsd(report.totals.costUsd)}
            </p>
          </div>
          <div className="text-right">
            <p className="m-0 text-xs text-dim">Processed tokens</p>
            <p className="m-0 text-md font-semibold tabular-nums">
              <TokenCount value={report.totals.totalTokens} />
            </p>
          </div>
        </div>
        <TokenMix totals={report.totals} compact />
        <CacheStats totals={report.totals} compact />
      </SettingsCard>
      {report.totals.costUsd === null ? (
        <div
          role="status"
          className="flex gap-2.5 rounded-[10px] border border-warning-solid/40 bg-warning-solid/10 p-3 text-xs leading-relaxed text-warning"
        >
          <TriangleAlertIcon aria-hidden="true" className="mt-px size-4 flex-none" />
          <p className="m-0">
            {unpriced.length
              ? `No price is available for ${unpriced.map((model) => shortModelId(model.modelId)).join(", ")}.`
              : "Pricing is unavailable for one or more models."}{" "}
            Tokens are still counted.
          </p>
        </div>
      ) : null}
    </>
  );
}

function ModelList({ report }: { report: WispSessionReport }) {
  if (report.models.length === 0) return null;
  const models = [...report.models].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));
  const topCost = Math.max(0, ...models.map((model) => model.costUsd ?? 0));
  return (
    <SettingsGroup label="By model" className="[&>h3]:mt-0">
      <SettingsCard variant="stacked">
        {models.map((model) => (
          <div
            key={`${model.auxiliary ? `${model.auxiliary.task}:` : ""}${model.providerId}:${model.modelId}`}
            className="flex flex-col gap-1.5 px-3 py-2.5 text-xs"
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 break-words text-sm" title={model.modelId}>
                {shortModelId(model.modelId)}
                {model.auxiliary ? (
                  <span className="ml-1.5 rounded-full bg-accent px-1.5 text-2xs text-dim">image model</span>
                ) : null}
                {model.plan ? (
                  <span className="ml-1.5 rounded-full bg-accent px-1.5 text-2xs text-dim">Claude plan</span>
                ) : null}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap font-semibold tabular-nums",
                  model.costUsd === null && "font-normal text-dim",
                )}
              >
                {formatUsd(model.costUsd)}
              </span>
            </div>
            {topCost && model.costUsd !== null ? (
              <span aria-hidden="true" className="block h-1 rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-chart-2"
                  style={{ width: `${(model.costUsd / topCost) * 100}%` }}
                />
              </span>
            ) : null}
            <span className="text-dim tabular-nums">
              {model.auxiliary ? plural(model.auxiliary.calls, "call") : plural(model.turns, "turn")} ·{" "}
              <TokenCount value={model.usage.totalTokens} /> tokens
            </span>
          </div>
        ))}
      </SettingsCard>
    </SettingsGroup>
  );
}

/** Usage that the totals include although no turn of the conversation spent it directly. */
function IncludedUsage({ report }: { report: WispSessionReport }) {
  const rows = [
    { label: "Context summaries", usage: report.compactionUsage },
    { label: "Reading images", usage: report.auxiliaryUsage },
  ].filter((row) => row.usage?.totalTokens);
  if (rows.length === 0) return null;
  return (
    <SettingsGroup label="Included in the totals" className="[&>h3]:mt-0">
      <SettingsCard className="space-y-1.5 p-3 text-xs">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-dim">{row.label}</dt>
              <dd className="m-0 text-right tabular-nums">
                <TokenCount value={row.usage?.totalTokens ?? 0} /> tokens
              </dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-dim">Their costs use the runtime's recorded estimate.</p>
      </SettingsCard>
    </SettingsGroup>
  );
}

type ToolFilter = { kind: "all" } | { kind: "failed" } | { kind: "tool"; name: string };

function ToolCallList({ toolCalls }: { toolCalls: ReadonlyArray<SessionReportToolCall> }) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const [filter, setFilter] = useState<ToolFilter>({ kind: "all" });
  if (toolCalls.length === 0) return <p className="m-0 text-xs text-dim">No tool calls recorded.</p>;
  const failed = toolCalls.filter((call) => call.status === "error").length;
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const call of toolCalls) {
    counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
    labels.set(call.toolName, toolCallLabel(call));
  }
  const topTools = [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOOL_FILTERS_SHOWN);
  const filters: Array<{ filter: ToolFilter; label: string }> = [
    { filter: { kind: "all" }, label: `All ${toolCalls.length}` },
    ...(failed ? [{ filter: { kind: "failed" } as const, label: `Failed ${failed}` }] : []),
    ...(counts.size > 1
      ? topTools.map(([name, count]) => ({
          filter: { kind: "tool", name } as const,
          label: `${labels.get(name) ?? name} ${count}`,
        }))
      : []),
  ];
  const sameFilter = (a: ToolFilter, b: ToolFilter) =>
    a.kind === b.kind && (a.kind !== "tool" || (b.kind === "tool" && a.name === b.name));
  const shown = toolCalls.filter((call) =>
    filter.kind === "all" ? true : filter.kind === "failed" ? call.status === "error" : call.toolName === filter.name,
  );
  return (
    <div className="flex flex-col gap-2">
      {filters.length > 1 ? (
        <div role="group" aria-label="Filter tool calls" className="flex flex-wrap gap-1">
          {filters.map((option) => {
            const pressed = sameFilter(option.filter, filter);
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={pressed}
                onClick={() => setFilter(option.filter)}
                className={cn(
                  "rounded-full border border-border px-2 py-0.5 text-xs tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  pressed ? "border-foreground bg-foreground text-background" : "hover:bg-accent",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs">
        {shown.map((toolCall) => (
          <li
            key={toolCall.toolCallId}
            className="grid min-w-0 grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 rounded-md px-1 py-1"
          >
            <ToolStatus status={toolCall.status} />
            <span className="min-w-0 break-words" title={toolCall.toolName}>
              {toolCallLabel(toolCall)}
              {toolCall.commandResult ? (
                <span className="text-dim"> · {describeCommandResult(toolCall.commandResult)}</span>
              ) : null}
            </span>
            <span className="whitespace-nowrap text-dim">
              {formatTimestamp(toolCall.timestamp, timeZone, timeFormat)}
            </span>
            {toolCall.purpose ? (
              <span className="col-start-2 col-end-4 break-words text-dim">{toolCall.purpose}</span>
            ) : null}
            {toolCall.commandOutline ? (
              <span className="col-start-2 col-end-4 break-all font-mono text-dim">{toolCall.commandOutline}</span>
            ) : null}
            {toolCall.argumentSummary ? (
              <span className="col-start-2 col-end-4 break-all text-dim">{toolCall.argumentSummary}</span>
            ) : null}
            {toolCall.imageModel ? (
              <span className="col-start-2 col-end-4 break-all text-dim">
                {toolCall.imageModel.fromCache
                  ? `From ${toolCall.imageModel.name}'s saved transcription`
                  : `Read with ${toolCall.imageModel.name}`}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The tool's readable name; servers from before readable names send only the raw one. */
function toolCallLabel(toolCall: SessionReportToolCall): string {
  return toolCall.toolLabel ?? toolCall.toolName;
}

function describeCommandResult(result: NonNullable<SessionReportToolCall["commandResult"]>): string {
  const ending =
    result.stopped === "timeout"
      ? "timed out"
      : result.stopped === "aborted"
        ? "stopped"
        : result.exitCode !== undefined
          ? `exit ${result.exitCode}`
          : "";
  const duration = result.durationMs === undefined ? "" : formatDuration(result.durationMs);
  return [ending, duration].filter(Boolean).join(" · ");
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ToolStatus({ status }: { status: SessionReportToolCall["status"] }) {
  const label = status === "error" ? "Failed" : status === "pending" ? "Running" : "Completed";
  const Icon = status === "error" ? XIcon : status === "pending" ? CircleDashedIcon : CheckIcon;
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "mt-px",
        status === "error" ? "text-destructive" : status === "pending" ? "text-dim" : "text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </span>
  );
}

const EVENT_LABELS = {
  error: "Error",
  compaction: "Context summarized",
  retry_started: "Retry started",
  retry_finished: "Retry finished",
  fallback: "Fallback",
} as const;

function EventList({ report }: { report: WispSessionReport }) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  if (report.events.length === 0) return <p className="m-0 text-xs text-dim">No events recorded.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
      {report.events.map((event, index) => (
        <li key={`${event.kind}:${event.timestamp}:${index}`} className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-baseline gap-1.5">
            <span className={event.kind === "error" ? "text-destructive" : "text-foreground"}>
              {EVENT_LABELS[event.kind]}
            </span>
            <span className="ml-auto shrink-0 text-dim">{formatTimestamp(event.timestamp, timeZone, timeFormat)}</span>
          </span>
          <span className="break-all text-dim">{event.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function SessionDetails({ report }: { report: WispSessionReport }) {
  const [copied, setCopied] = useState(false);
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-dim">Session</dt>
      <dd className="m-0 truncate font-mono" title={report.sessionId}>
        {report.sessionId}
      </dd>
      <dd className="m-0">
        <Button
          size="xs"
          variant="ghost"
          type="button"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(report.sessionId)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </dd>
      {report.piVersion ? (
        <>
          <dt className="text-dim">Pi version</dt>
          <dd className="col-span-2 m-0">{report.piVersion}</dd>
        </>
      ) : null}
    </dl>
  );
}

function CountBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-accent px-1.5 text-2xs font-normal text-dim tabular-nums">{children}</span>;
}

function FailedBadge({ count, noun = "failed" }: { count: number; noun?: "failed" | "error" }) {
  if (!count) return null;
  return (
    <span className="rounded-full bg-destructive/10 px-1.5 text-2xs font-normal text-destructive tabular-nums">
      {noun === "failed" ? `${count} failed` : plural(count, "error")}
    </span>
  );
}

function ReportSkeleton() {
  const bar = "rounded-md bg-muted motion-safe:animate-pulse";
  return (
    <>
      <p role="status" className="sr-only">
        Loading session activity…
      </p>
      <div aria-hidden="true" className="flex flex-col gap-3.5">
        <div className={cn(bar, "h-2.5 w-40")} />
        <SettingsCard className="space-y-3 p-3">
          <div className={cn(bar, "h-2.5 w-20")} />
          <div className={cn(bar, "h-7 w-28")} />
          <div className={cn(bar, "h-3 w-full rounded-full")} />
        </SettingsCard>
        <SettingsCard variant="stacked">
          {[0, 1].map((row) => (
            <div key={row} className="space-y-2 px-3 py-3">
              <div className={cn(bar, "h-2.5 w-3/5")} />
              <div className={cn(bar, "h-1 w-full")} />
            </div>
          ))}
        </SettingsCard>
      </div>
    </>
  );
}

/** The model's own name, without its vendor prefix (openai/gpt-oss-120b → gpt-oss-120b). */
function shortModelId(modelId: string): string {
  return modelId.split("/").pop() || modelId;
}

function formatTimestamp(value: string, timeZone: string, timeFormat: TimeFormat): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", ...clockTimeOptions(timeFormat), timeZone });
}
