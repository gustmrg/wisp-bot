import { useState } from "react";
import { ChevronDownIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import { Wisp } from "@/components/wisp";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { useJobs, type JobsController } from "@/hooks/use-jobs";
import { useTimeFormat, useTimeZone } from "@/hooks/use-time-zone";
import { clockTimeOptions } from "@/lib/clock-time";
import type { WispOption } from "@/lib/plugin-access";
import { cn } from "@/lib/utils";
import { isJobFinished, type Job, type JobRun, type JobRunStatus, type JobRunTrigger } from "../../shared/jobs";
import { describeSchedule } from "../../shared/schedule";

const STATUS_LABELS: Record<JobRunStatus, string> = {
  delivered: "Delivered",
  silent: "Nothing to report",
  failed: "Failed",
  skipped: "Skipped, still running",
};

const TRIGGER_LABELS: Record<JobRunTrigger, string> = {
  on_time: "On time",
  catch_up: "Caught up",
  retry: "Retry",
  manual: "Run now",
};

const ERROR_LABELS: Record<string, string> = {
  timed_out: "took longer than 15 minutes",
  empty_response: "finished without a message",
  configuration_required: "no model is set up",
  model_unavailable: "the model is unavailable",
  not_found: "something it needs no longer exists",
  aborted: "stopped",
  disposed: "the app stopped",
};

function errorText(code: string | undefined): string | undefined {
  return code ? (ERROR_LABELS[code] ?? code.replaceAll("_", " ")) : undefined;
}

/**
 * Every Wisp's jobs (ADR 019): when they run next, how their last run went,
 * and their recent runs. People pause, resume, run and delete jobs here; only
 * Wisps create or change them, when asked in their conversation. Finished
 * jobs stay stored but are not listed.
 */
export function JobsSettingsSection({ wisps = [] }: { wisps?: ReadonlyArray<WispOption> }) {
  const controller = useJobs();
  const wispsById = new Map(wisps.map((wisp) => [wisp.id, wisp]));
  const listed = controller.jobs.filter((job) => !isJobFinished(job));
  const groups = new Map<string, Job[]>();
  for (const job of listed) groups.set(job.conversationId, [...(groups.get(job.conversationId) ?? []), job]);
  return (
    <section
      id="jobs-settings-panel"
      aria-labelledby="jobs-settings-title"
      className="min-w-0 overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
    >
      <h2 id="jobs-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Jobs
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Tasks your Wisps run on a schedule in the background, sending you only their results. To create or change a job,
        ask a Wisp, for example: “Every weekday at 9:00, look for new openings and send me a summary.”
      </p>
      {listed.length === 0 ? (
        <p role="status" className="mx-0.5 text-xs text-dim">
          {!controller.available ? "Loading jobs…" : controller.jobs.length ? "No scheduled jobs." : "No jobs yet."}
        </p>
      ) : (
        [...groups].map(([conversationId, jobs]) => {
          const wisp = wispsById.get(conversationId);
          return (
            <SettingsGroup
              key={conversationId}
              label={
                <span className="flex items-center gap-1.5">
                  <Wisp
                    aria-hidden="true"
                    className="flex-none"
                    appearance={wisp?.appearance}
                    color={wisp?.color}
                    name={wisp?.name ?? "Wisp"}
                    size="sm"
                  />
                  {wisp?.name ?? "Wisp"}
                </span>
              }
            >
              <SettingsCard variant="stacked">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} controller={controller} />
                ))}
              </SettingsCard>
            </SettingsGroup>
          );
        })
      )}
    </section>
  );
}

function JobRow({ job, controller }: { job: Job; controller: JobsController }) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [runs, setRuns] = useState<ReadonlyArray<JobRun> | string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const format = (time: string) =>
    new Date(time).toLocaleString([], {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      ...clockTimeOptions(timeFormat),
    });

  async function act(action: (jobId: string) => Promise<string | null>) {
    setBusy(true);
    setError(await action(job.id));
    setBusy(false);
    if (expanded) setRuns(await controller.loadRuns(job.id));
  }

  async function toggleRuns() {
    const next = !expanded;
    setExpanded(next);
    if (next) setRuns(await controller.loadRuns(job.id));
  }

  const next = job.paused
    ? job.paused.reason === "failures"
      ? "Paused after failing several times in a row"
      : "Paused"
    : job.nextRunAt
      ? `Next run ${format(job.nextRunAt)}`
      : job.lastRun?.status === "failed"
        ? "Failed, will not run again"
        : "Its schedule has ended";
  const failedForGood = !job.nextRunAt && job.lastRun?.status === "failed";
  const last = job.lastRun
    ? `Last run ${format(job.lastRun.endedAt)}: ${STATUS_LABELS[job.lastRun.status]}${
        job.lastRun.errorCode ? `, ${errorText(job.lastRun.errorCode)}` : ""
      }${job.lastRun.deliveryErrorCode ? `, the message could not be added (${errorText(job.lastRun.deliveryErrorCode)})` : ""}`
    : "It has not run yet.";
  const runsId = `job-runs-${job.id}`;
  return (
    <div>
      <SettingsRow className="flex-wrap items-start">
        <SettingsRowCopy className="min-w-[200px]">
          <SettingsRowTitle>{job.title}</SettingsRowTitle>
          <SettingsRowDescription>{describeSchedule(job.schedule, job.timeZone)}</SettingsRowDescription>
          <SettingsRowDescription
            className={cn((job.paused?.reason === "failures" || failedForGood) && "text-destructive")}
          >
            {next}
          </SettingsRowDescription>
          <SettingsRowDescription className={cn(job.lastRun?.status === "failed" && "text-destructive")}>
            {last}
          </SettingsRowDescription>
          {error ? (
            <p role="alert" className="m-0 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </SettingsRowCopy>
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(controller.runNow)}>
            <RefreshCwIcon aria-hidden="true" />
            Run now
          </Button>
          {job.paused ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(controller.resume)}>
              <PlayIcon aria-hidden="true" />
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(controller.pause)}>
              <PauseIcon aria-hidden="true" />
              Pause
            </Button>
          )}
          {confirmingDelete ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void act(controller.remove)}>
                Delete job
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${job.title}`}
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={runsId}
            onClick={() => void toggleRuns()}
          >
            Runs
            <ChevronDownIcon aria-hidden="true" className={cn("transition-transform", expanded && "rotate-180")} />
          </Button>
        </div>
      </SettingsRow>
      {expanded ? (
        <div id={runsId} className="px-3.5 pb-3">
          {runs === null ? (
            <p role="status" className="m-0 text-xs text-dim">
              Loading runs…
            </p>
          ) : typeof runs === "string" ? (
            <p role="alert" className="m-0 text-xs text-destructive">
              {runs}
            </p>
          ) : runs.length === 0 ? (
            <p className="m-0 text-xs text-dim">No runs yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs" aria-label={`Recent runs of ${job.title}`}>
              {runs.map((run) => (
                <RunItem key={run.id} run={run} format={format} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RunItem({ run, format }: { run: JobRun; format: (time: string) => string }) {
  const lateMinutes = Math.round((Date.parse(run.startedAt) - Date.parse(run.scheduledAt)) / 60_000);
  const details = [
    TRIGGER_LABELS[run.trigger],
    run.trigger !== "manual" && lateMinutes >= 1 ? `${lateMinutes} min late` : undefined,
    run.skipReason,
    errorText(run.errorCode),
    run.deliveryErrorCode ? `message not added: ${errorText(run.deliveryErrorCode)}` : undefined,
    run.usage ? `${run.usage.totalTokens.toLocaleString("en-US")} tokens` : undefined,
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <span className="tabular-nums text-dim">{format(run.scheduledAt)}</span>
      <span className={cn("font-medium", run.status === "failed" && "text-destructive")}>
        {run.status ? STATUS_LABELS[run.status] : "Running…"}
      </span>
      <span className="w-full text-faint">{details.join(" · ")}</span>
    </li>
  );
}
