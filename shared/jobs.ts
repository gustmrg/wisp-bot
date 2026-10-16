import type { SessionReportUsage } from "./contracts.js";
import type { ChatId } from "./conversations.js";
import type { Schedule } from "./schedule.js";

/** Jobs a single Wisp may hold at once; finished jobs do not count. */
export const MAX_JOBS_PER_WISP = 20;
/** Runs kept for each job; older records are removed as new ones arrive. */
export const MAX_JOB_RUNS_KEPT = 50;
/** The largest saved state a run may leave for the next, in bytes of UTF-8. */
export const MAX_JOB_STATE_BYTES = 16 * 1024;
export const MAX_JOB_TITLE_LENGTH = 80;
export const MAX_JOB_INSTRUCTIONS_LENGTH = 16_000;
/** Skills and tools a job may list. */
export const MAX_JOB_SKILLS = 20;
export const MAX_JOB_TOOLS = 50;

/**
 * - `delivered`: the run's final response was added to the conversation.
 * - `silent`: the run ended with `skip_delivery`, as in "nothing new".
 * - `failed`: the run did not finish, or finished with nothing to deliver.
 * - `skipped`: the occurrence came while the job's previous run was still going.
 */
export type JobRunStatus = "delivered" | "silent" | "failed" | "skipped";
/** How a run was started. */
export type JobRunTrigger = "on_time" | "catch_up" | "retry" | "manual";

/** Why a job is paused: the person paused it, or it failed too many times in a row. */
export type JobPauseReason = "person" | "failures";

/** A retry of a failed occurrence, waiting at the job's `nextRunAt`. */
export interface JobRetry {
  /** 1 for the first retry, 2 for the second. */
  attempt: number;
  /** The occurrence being retried (ISO 8601, UTC). */
  scheduledAt: string;
}

/** The outcome of a job's most recent run, kept on the job so lists need not read run records. */
export interface JobLastRun {
  runId: string;
  status: JobRunStatus;
  endedAt: string;
  /** Why the run failed, as a backend error code. */
  errorCode?: string;
  /** Why a run that produced a message could not deliver it; the run itself is not repeated. */
  deliveryErrorCode?: string;
}

/**
 * A task a Wisp runs in its own background session on a schedule; only its
 * result reaches the conversation. See ADR 019.
 */
export interface Job {
  id: string;
  /** The Wisp's own conversation, where results are delivered and from which the job is managed. */
  conversationId: ChatId;
  title: string;
  /** Self-contained instructions; a run does not see the conversation that created the job. */
  instructions: string;
  /** Names of the Wisp's own skills loaded into every run. */
  skills: ReadonlyArray<string>;
  /** Tools a run may use; approving the job authorizes them for its runs. */
  tools: ReadonlyArray<string>;
  schedule: Schedule;
  /** IANA time zone the job was created in, so wall-clock schedules follow it even on a server elsewhere. */
  timeZone: string;
  /** When it runs next (ISO 8601, UTC); absent once the schedule has ended. */
  nextRunAt?: string;
  /** A retry waiting at `nextRunAt`, instead of the next occurrence. */
  retry?: JobRetry;
  paused?: { reason: JobPauseReason; at: string };
  /** What the last run saved for the next with `save_job_state`. */
  state: string;
  /** Occurrences claimed so far, including skipped ones; schedules that end after a number of runs count these. */
  runCount: number;
  /** Failed occurrences in a row; a delivered or silent run resets it. */
  consecutiveFailures: number;
  lastRun?: JobLastRun;
  createdAt: string;
  updatedAt: string;
}

export interface JobRun {
  id: string;
  jobId: string;
  conversationId: ChatId;
  trigger: JobRunTrigger;
  /** The occurrence this run is for (ISO 8601, UTC); for a manual run, when it was asked for. */
  scheduledAt: string;
  startedAt: string;
  /** Absent while the run is going. */
  endedAt?: string;
  /** Absent while the run is going. */
  status?: JobRunStatus;
  errorCode?: string;
  deliveryErrorCode?: string;
  /** The reason the run gave to `skip_delivery`. */
  skipReason?: string;
  usage?: SessionReportUsage;
  /** The delivered message, in the job's conversation. */
  messageId?: string;
  /** The run's Pi session file, kept for debugging. */
  sessionFile?: string;
}

/** How late a run started, in milliseconds. */
export function jobRunLateness(run: Pick<JobRun, "scheduledAt" | "startedAt">): number {
  return Math.max(0, Date.parse(run.startedAt) - Date.parse(run.scheduledAt));
}

/**
 * A job whose schedule has ended after a run that did not fail. It stays
 * stored but is no longer listed; one whose last run failed stays listed
 * until it is deleted.
 */
export function isJobFinished(job: Pick<Job, "nextRunAt" | "paused" | "lastRun">): boolean {
  return !job.nextRunAt && !job.paused && job.lastRun !== undefined && job.lastRun.status !== "failed";
}

export interface JobsView {
  /** Every job, soonest next run first; jobs that will not run again come last. */
  jobs: ReadonlyArray<Job>;
}

export interface JobRequest {
  jobId: string;
}

export interface JobRunsView {
  jobId: string;
  /** The job's recent runs, newest first. */
  runs: ReadonlyArray<JobRun>;
}
