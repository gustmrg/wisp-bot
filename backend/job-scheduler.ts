import { randomUUID } from "node:crypto";

import type { SessionReportUsage } from "../shared/contracts.js";
import {
  type Job,
  type JobRun,
  type JobRunStatus,
  type JobRunTrigger,
  type JobRunsView,
  type JobsView,
  MAX_JOB_RUNS_KEPT,
  MAX_JOBS_PER_WISP,
} from "../shared/jobs.js";
import { nextOccurrence, type Schedule } from "../shared/schedule.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { StructuredLogger } from "./structured-logger.js";

/** See `MessageScheduler`: timers stop while a laptop sleeps, so the clock is checked regularly. */
const MAX_TIMER_DELAY_MS = 60_000;
/** A time this recent counts as now rather than past. */
const PAST_TIME_GRACE_MS = 60_000;
/** A run claimed later than this after its time was missed while the backend was stopped. */
const CATCH_UP_AFTER_MS = 2 * 60_000;

export const JOB_RUN_TIMEOUT_MS = 15 * 60_000;
export const MAX_CONCURRENT_JOB_RUNS = 2;
/** Delays before the first and second retry of an occurrence that failed for a reason that may pass. */
export const JOB_RETRY_DELAYS_MS: ReadonlyArray<number> = [5 * 60_000, 15 * 60_000];
/** Failed occurrences in a row after which a job pauses itself. */
export const MAX_CONSECUTIVE_JOB_FAILURES = 3;

/** What a run ended with: a message to deliver, or nothing to say. A run that fails throws. */
export type JobRunOutcome =
  | { kind: "message"; text: string; usage?: SessionReportUsage; sessionFile?: string }
  | { kind: "silent"; reason: string; usage?: SessionReportUsage; sessionFile?: string };

export interface JobRunContext {
  run: JobRun;
  /** When the job's previous run ended, if it ran before. */
  lastRunAt?: string;
  /** Aborted when the run times out or the backend stops. */
  signal: AbortSignal;
  /** Replaces the job's saved state for the next run; see `save_job_state`. */
  saveState: (state: string) => Promise<void>;
}

/** Fields a new job is created with; see `JobScheduler.create`. */
export interface NewJob {
  conversationId: string;
  title: string;
  instructions: string;
  skills: ReadonlyArray<string>;
  tools: ReadonlyArray<string>;
  schedule: Schedule;
  timeZone: string;
}

export type JobChanges = Partial<Omit<NewJob, "conversationId">>;

export interface JobSchedulerOptions {
  repository: Pick<ConversationRepository, "listJobs" | "addJob" | "changeJob" | "listJobRuns" | "putJobRun">;
  /** Runs the job in its own background session. Throws when the run fails. */
  runJob: (job: Job, context: JobRunContext) => Promise<JobRunOutcome>;
  /** Adds a run's message to the job's conversation; resolves with the new message's ID. */
  deliver: (job: Job, text: string, run: JobRun) => Promise<string>;
  /** Tells the person about the job in its conversation, such as that it paused itself. */
  notify: (job: Job, text: string) => Promise<void>;
  /** Receives every job after any change, including runs. */
  onChanged: (view: JobsView) => void;
  logger?: Pick<StructuredLogger, "warn">;
  now?: () => Date;
  createId?: () => string;
  runTimeoutMs?: number;
  maxConcurrentRuns?: number;
}

export interface QueuedRun {
  job: Job;
  trigger: JobRunTrigger;
  scheduledAt: string;
  /** Retries of this occurrence so far: 0 for its first run. */
  attempt: number;
}

/**
 * Runs jobs when they are due, whether or not any client is connected (ADR
 * 019). An occurrence is claimed (the job advanced) before its run starts, so
 * a crash in between can lose a run but never repeat one. Occurrences missed
 * while the backend was stopped collapse into one run as soon as it starts.
 * Each job runs once at a time, and a few runs at most go at once.
 */
export class JobScheduler {
  private readonly repository: JobSchedulerOptions["repository"];
  private readonly runJob: JobSchedulerOptions["runJob"];
  private readonly deliver: JobSchedulerOptions["deliver"];
  private readonly notify: JobSchedulerOptions["notify"];
  private readonly onChanged: JobSchedulerOptions["onChanged"];
  private readonly logger: JobSchedulerOptions["logger"];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly runTimeoutMs: number;
  private readonly maxConcurrentRuns: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking: Promise<void> = Promise.resolve();
  private readonly waiting: QueuedRun[] = [];
  /** Runs going now, by job ID. */
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private disposed = false;

  constructor(options: JobSchedulerOptions) {
    this.repository = options.repository;
    this.runJob = options.runJob;
    this.deliver = options.deliver;
    this.notify = options.notify;
    this.onChanged = options.onChanged;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.runTimeoutMs = options.runTimeoutMs ?? JOB_RUN_TIMEOUT_MS;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? MAX_CONCURRENT_JOB_RUNS;
  }

  /** Starts watching the clock; overdue jobs run right after. */
  start(): void {
    this.arm(0);
  }

  async getView(): Promise<JobsView> {
    return { jobs: await this.repository.listJobs() };
  }

  async getJob(jobId: string): Promise<Job> {
    const job = (await this.repository.listJobs()).find(({ id }) => id === jobId);
    if (!job) throw notFound();
    return job;
  }

  async listRuns(jobId: string): Promise<JobRunsView> {
    return { jobId, runs: await this.repository.listJobRuns(jobId, MAX_JOB_RUNS_KEPT) };
  }

  /** Saves an approved job; its first run is the schedule's first occurrence from now. */
  async create(request: NewJob): Promise<Job> {
    const now = this.now();
    const job: Job = {
      id: this.createId(),
      conversationId: request.conversationId,
      title: request.title,
      instructions: request.instructions,
      skills: [...request.skills],
      tools: [...request.tools],
      schedule: request.schedule,
      timeZone: request.timeZone,
      nextRunAt: firstRun(request.schedule, request.timeZone, now, 0),
      state: "",
      runCount: 0,
      consecutiveFailures: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.repository.addJob(job, MAX_JOBS_PER_WISP);
    await this.changed();
    return job;
  }

  /** Changes a job; its next run is recomputed when the schedule or time zone changes. */
  async update(jobId: string, changes: JobChanges): Promise<Job> {
    const now = this.now();
    let updated: Job | undefined;
    const previous = await this.repository.changeJob(jobId, (current) => {
      const next: Job = {
        ...current,
        ...definedOf(changes),
        skills: changes.skills ? [...changes.skills] : current.skills,
        tools: changes.tools ? [...changes.tools] : current.tools,
        updatedAt: now.toISOString(),
      };
      updated =
        changes.schedule !== undefined || changes.timeZone !== undefined
          ? withNextRun(next, firstRun(next.schedule, next.timeZone, now, next.runCount))
          : next;
      return updated;
    });
    if (!previous || !updated) throw notFound();
    await this.changed();
    return updated;
  }

  /** Deletes a job and its runs; a run going now is stopped. */
  async delete(jobId: string): Promise<void> {
    const previous = await this.repository.changeJob(jobId, () => null);
    if (!previous) throw notFound();
    this.active.get(jobId)?.controller.abort(new WispBackendError("aborted", "The job was deleted."));
    this.removeWaiting(jobId);
    await this.changed();
  }

  async pause(jobId: string): Promise<Job> {
    const at = this.now().toISOString();
    return this.change(jobId, (current) =>
      current.paused ? undefined : { ...current, paused: { reason: "person", at }, updatedAt: at },
    );
  }

  /** Resumes from now: occurrences missed while paused do not run, and the failure count starts over. */
  async resume(jobId: string): Promise<Job> {
    const now = this.now();
    return this.change(jobId, (current) => {
      if (!current.paused) return undefined;
      const { paused: _paused, retry: _retry, ...rest } = current;
      const next = nextOccurrence(current.schedule, current.timeZone, now, current.runCount);
      return withNextRun({ ...rest, consecutiveFailures: 0, updatedAt: now.toISOString() }, next?.toISOString());
    });
  }

  /** Runs a job now without changing its schedule, unless it is running already. */
  async runNow(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (this.active.has(jobId) || this.waiting.some((queued) => queued.job.id === jobId)) {
      throw new WispBackendError("invalid_request", "This job is already running.");
    }
    this.enqueue({ job, trigger: "manual", scheduledAt: this.now().toISOString(), attempt: 0 });
  }

  /** True while the job is running or waiting for a free slot. */
  isRunning(jobId: string): boolean {
    return this.active.has(jobId) || this.waiting.some((queued) => queued.job.id === jobId);
  }

  /** Publishes the current jobs after a change made elsewhere, such as a deleted Wisp. */
  refresh(): void {
    void this.changed().catch((error) => this.warn("jobs_refresh_failed", error));
  }

  /** Stops checking the clock and stops runs going now. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting.length = 0;
    await this.checking;
    for (const { controller } of this.active.values()) {
      controller.abort(new WispBackendError("disposed", "The backend stopped."));
    }
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }

  private async change(jobId: string, change: (current: Job) => Job | undefined): Promise<Job> {
    let updated: Job | undefined;
    const previous = await this.repository.changeJob(jobId, (current) => {
      updated = change(current);
      return updated;
    });
    // Unchanged: either it is missing or it already was what was asked.
    if (!previous || !updated) return this.getJob(jobId);
    await this.changed();
    return updated;
  }

  private async changed(): Promise<JobsView> {
    const view = await this.getView();
    this.rearm(view.jobs);
    this.onChanged(view);
    return view;
  }

  private rearm(jobs: ReadonlyArray<Job>): void {
    const soonest = jobs.find((job) => job.nextRunAt && !job.paused);
    if (!soonest?.nextRunAt) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    this.arm(Date.parse(soonest.nextRunAt) - this.now().getTime());
  }

  private arm(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.checking = this.checking.then(() => this.claimDue());
      },
      Math.min(Math.max(delayMs, 0), MAX_TIMER_DELAY_MS),
    );
  }

  private async claimDue(): Promise<void> {
    if (this.disposed) return;
    try {
      const now = this.now();
      let claimed = false;
      for (const job of await this.repository.listJobs()) {
        if (this.disposed) return;
        if (job.paused || !job.nextRunAt || Date.parse(job.nextRunAt) > now.getTime()) continue;
        let queued: QueuedRun | undefined;
        // Checked again in the write queue: the job may have changed since the list was read.
        await this.repository.changeJob(job.id, (current) => {
          if (current.paused || !current.nextRunAt || Date.parse(current.nextRunAt) > now.getTime()) return undefined;
          const claim = claimOccurrence(current, now);
          queued = claim;
          return claim.job;
        });
        if (!queued) continue;
        claimed = true;
        if (this.isRunning(job.id)) await this.recordSkipped(queued, now);
        else this.enqueue(queued);
      }
      if (claimed) await this.changed();
      else this.rearm(await this.repository.listJobs());
    } catch (error) {
      this.warn("jobs_check_failed", error);
      this.arm(MAX_TIMER_DELAY_MS);
    }
  }

  private enqueue(queued: QueuedRun): void {
    if (this.disposed) return;
    this.waiting.push(queued);
    this.startWaiting();
  }

  private startWaiting(): void {
    while (!this.disposed && this.active.size < this.maxConcurrentRuns) {
      const index = this.waiting.findIndex((queued) => !this.active.has(queued.job.id));
      if (index < 0) return;
      const [queued] = this.waiting.splice(index, 1);
      const controller = new AbortController();
      const entry = { controller, done: Promise.resolve() };
      this.active.set(queued!.job.id, entry);
      entry.done = this.execute(queued!, controller)
        .catch((error) => this.warn("job_run_failed", error, queued!.job))
        .finally(() => {
          this.active.delete(queued!.job.id);
          this.startWaiting();
        });
    }
  }

  private removeWaiting(jobId: string): void {
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      if (this.waiting[index]!.job.id === jobId) this.waiting.splice(index, 1);
    }
  }

  private async execute(queued: QueuedRun, controller: AbortController): Promise<void> {
    // The latest version, in case it changed while waiting for a slot.
    const job = (await this.repository.listJobs()).find(({ id }) => id === queued.job.id);
    if (!job) return;
    const run: JobRun = {
      id: this.createId(),
      jobId: job.id,
      conversationId: job.conversationId,
      trigger: queued.trigger,
      scheduledAt: queued.scheduledAt,
      startedAt: this.now().toISOString(),
    };
    await this.repository.putJobRun(run);

    const timedOut = new WispBackendError("aborted", "The job ran for too long.");
    const timeout = setTimeout(() => controller.abort(timedOut), this.runTimeoutMs);
    let ended: JobRun;
    try {
      const outcome = await abortable(
        this.runJob(job, {
          run,
          ...(job.lastRun ? { lastRunAt: job.lastRun.endedAt } : {}),
          signal: controller.signal,
          saveState: (state) => this.saveState(job.id, state),
        }),
        controller.signal,
      );
      ended = await this.finish(job, run, outcome);
    } catch (error) {
      // Besides backend error codes, a run fails with "timed_out" or "empty_response".
      ended = {
        ...run,
        endedAt: this.now().toISOString(),
        status: "failed",
        errorCode: controller.signal.reason === timedOut ? "timed_out" : sanitizeBackendError(error).code,
      };
      if (!this.disposed) this.warn("job_run_failed", error, job);
      await this.repository.putJobRun(ended);
      if (this.disposed) return;
      await this.recordOutcome(
        job,
        ended,
        isRetryable(error) && queued.trigger !== "manual" ? queued.attempt : undefined,
      );
      return;
    } finally {
      clearTimeout(timeout);
    }
    await this.repository.putJobRun(ended);
    await this.recordOutcome(job, ended);
  }

  private async finish(job: Job, run: JobRun, outcome: JobRunOutcome): Promise<JobRun> {
    const base: JobRun = {
      ...run,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}),
    };
    if (outcome.kind === "silent") {
      return { ...base, endedAt: this.now().toISOString(), status: "silent", skipReason: outcome.reason };
    }
    if (!outcome.text.trim()) {
      return { ...base, endedAt: this.now().toISOString(), status: "failed", errorCode: "empty_response" };
    }
    try {
      const messageId = await this.deliver(job, outcome.text, run);
      return { ...base, endedAt: this.now().toISOString(), status: "delivered", messageId };
    } catch (error) {
      this.warn("job_delivery_failed", error, job);
      return {
        ...base,
        endedAt: this.now().toISOString(),
        status: "failed",
        deliveryErrorCode: sanitizeBackendError(error).code,
      };
    }
  }

  /**
   * Updates the job after a run: its last outcome and failure count, a retry
   * for a failure that may pass, or a pause after too many failures in a row.
   * `retryAttempt` is set for a failure that may pass: the retries of the
   * occurrence so far.
   */
  private async recordOutcome(job: Job, run: JobRun, retryAttempt?: number): Promise<void> {
    const status = run.status as JobRunStatus;
    const failed = status === "failed";
    let pausedNow: Job | undefined;
    await this.repository.changeJob(job.id, (current) => {
      const { retry: _retry, ...rest } = current;
      const lastRun = {
        runId: run.id,
        status,
        endedAt: run.endedAt ?? this.now().toISOString(),
        ...(run.errorCode ? { errorCode: run.errorCode } : {}),
        ...(run.deliveryErrorCode ? { deliveryErrorCode: run.deliveryErrorCode } : {}),
      };
      if (!failed) return { ...rest, lastRun, consecutiveFailures: 0, updatedAt: lastRun.endedAt };
      const delay = retryAttempt === undefined ? undefined : JOB_RETRY_DELAYS_MS[retryAttempt];
      const retryAt = delay === undefined ? undefined : Date.parse(lastRun.endedAt) + delay;
      if (retryAt !== undefined && !current.paused && (!current.nextRunAt || retryAt < Date.parse(current.nextRunAt))) {
        // Waits at `nextRunAt`; the next occurrence is found again when the retry is claimed.
        return {
          ...rest,
          lastRun,
          retry: { attempt: (retryAttempt ?? 0) + 1, scheduledAt: run.scheduledAt },
          nextRunAt: new Date(retryAt).toISOString(),
          updatedAt: lastRun.endedAt,
        };
      }
      const consecutiveFailures = current.consecutiveFailures + 1;
      const next: Job = { ...rest, lastRun, consecutiveFailures, updatedAt: lastRun.endedAt };
      if (consecutiveFailures >= MAX_CONSECUTIVE_JOB_FAILURES && !current.paused) {
        pausedNow = { ...next, paused: { reason: "failures", at: lastRun.endedAt } };
        return pausedNow;
      }
      return next;
    });
    await this.changed();
    if (pausedNow) {
      await this.notify(
        pausedNow,
        `The job "${pausedNow.title}" failed ${MAX_CONSECUTIVE_JOB_FAILURES} times in a row and was paused. Resume it from the jobs list once the problem is fixed.`,
      ).catch((error) => this.warn("job_notice_failed", error, pausedNow));
    }
  }

  private async recordSkipped(queued: QueuedRun, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.repository.putJobRun({
      id: this.createId(),
      jobId: queued.job.id,
      conversationId: queued.job.conversationId,
      trigger: queued.trigger,
      scheduledAt: queued.scheduledAt,
      startedAt: at,
      endedAt: at,
      status: "skipped",
    });
  }

  private async saveState(jobId: string, state: string): Promise<void> {
    const previous = await this.repository.changeJob(jobId, (current) => ({ ...current, state }));
    if (!previous) throw notFound();
  }

  private warn(event: string, error: unknown, job?: Job): void {
    this.logger?.warn(event, {
      code: sanitizeBackendError(error).code,
      ...(job ? { conversationId: job.conversationId, jobId: job.id } : {}),
    });
  }
}

/**
 * Claims the occurrence due at `now`: a waiting retry, or the latest of the
 * occurrences missed so far, which collapse into one run. The job moves on to
 * its next occurrence after `now`.
 */
export function claimOccurrence(job: Job, now: Date): QueuedRun {
  const { retry, ...rest } = job;
  const dueAt = job.nextRunAt ?? now.toISOString();
  if (retry) {
    // The occurrence after the one being retried; when it is due too, it replaces the retry.
    const regular = nextOccurrence(job.schedule, job.timeZone, new Date(retry.scheduledAt), job.runCount);
    if (!regular || regular.getTime() > now.getTime()) {
      return {
        job: withNextRun({ ...rest, updatedAt: now.toISOString() }, regular?.toISOString()),
        trigger: "retry",
        scheduledAt: retry.scheduledAt,
        attempt: retry.attempt,
      };
    }
    return claimOccurrence({ ...rest, nextRunAt: regular.toISOString() }, now);
  }
  // Collapse: the latest occurrence missed, and then the first one after now.
  let scheduledAt = dueAt;
  for (;;) {
    const following = nextOccurrence(job.schedule, job.timeZone, new Date(scheduledAt), job.runCount + 1);
    if (!following || following.getTime() > now.getTime()) {
      const late = now.getTime() - Date.parse(dueAt) > CATCH_UP_AFTER_MS;
      return {
        job: withNextRun(
          { ...rest, runCount: job.runCount + 1, updatedAt: now.toISOString() },
          following?.toISOString(),
        ),
        trigger: late ? "catch_up" : "on_time",
        scheduledAt,
        attempt: 0,
      };
    }
    scheduledAt = following.toISOString();
  }
}

function withNextRun(job: Job, nextRunAt: string | undefined): Job {
  const { nextRunAt: _previous, ...rest } = job;
  return nextRunAt ? { ...rest, nextRunAt } : rest;
}

function firstRun(schedule: Schedule, timeZone: string, now: Date, completed: number): string {
  const first = nextOccurrence(schedule, timeZone, new Date(now.getTime() - PAST_TIME_GRACE_MS), completed);
  if (!first) throw new WispBackendError("invalid_request", "The schedule never runs after now.");
  return first.toISOString();
}

function definedOf<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

/** Resolves or rejects with `promise`, or rejects as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Provider, network and rate-limit errors may pass; the agent marks them retryable. */
function isRetryable(error: unknown): boolean {
  return error instanceof WispBackendError && error.retryable && error.code !== "aborted";
}

function notFound(): WispBackendError {
  return new WispBackendError("not_found", "The job was not found.");
}
