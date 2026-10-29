import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import {
  claimOccurrence,
  JobScheduler,
  type JobRunContext,
  type JobRunOutcome,
  type NewJob,
} from "../backend/job-scheduler.js";
import type { Chat } from "../shared/conversations.js";
import type { Job, JobsView } from "../shared/jobs.js";

// Sunday, October 11, 2026, 12:00 UTC.
const START = new Date("2026-10-11T12:00:00.000Z");
const MINUTE = 60_000;

function wispChat(id: string): Chat {
  return {
    id,
    kind: "wisp",
    shape: "circle",
    name: id,
    label: "Test",
    description: "A test Wisp",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    messages: [],
  } as unknown as Chat;
}

const DAILY: NewJob = {
  conversationId: "atlas",
  title: "Job openings",
  instructions: "Search for openings and report the new ones.",
  skills: [],
  tools: ["web_search"],
  schedule: { kind: "daily", time: "13:00" },
  timeZone: "UTC",
};

type Runner = (job: Job, context: JobRunContext) => Promise<JobRunOutcome>;

async function setup(options: { directory?: string; runner?: Runner; deliver?: () => Promise<string> } = {}) {
  const directory = options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "wisp-job-scheduler-")));
  const repository = new ConversationRepository({ dataDirectory: directory });
  if (options.directory) await repository.load();
  else await repository.initialize({ atlas: wispChat("atlas") });
  let now = START;
  let ids = 0;
  const runs: Array<{ job: Job; context: JobRunContext }> = [];
  const delivered: Array<{ job: Job; text: string }> = [];
  const notices: string[] = [];
  const views: JobsView[] = [];
  let runner: Runner = options.runner ?? (async () => ({ kind: "message", text: "Found 2 openings" }));
  const scheduler = new JobScheduler({
    repository,
    runJob: (job, context) => {
      runs.push({ job, context });
      return runner(job, context);
    },
    deliver:
      options.deliver ??
      (async (job, text) => {
        delivered.push({ job, text });
        return `message-${delivered.length}`;
      }),
    notify: async (_job, text) => {
      notices.push(text);
    },
    onChanged: (view) => views.push(view),
    now: () => now,
    createId: () => `id-${++ids}`,
  });
  return {
    directory,
    repository,
    scheduler,
    runs,
    delivered,
    notices,
    views,
    setRunner: (next: Runner) => {
      runner = next;
    },
    advance: async (ms: number) => {
      now = new Date(now.getTime() + ms);
      await vi.advanceTimersByTimeAsync(ms);
    },
    close: async () => {
      await scheduler.dispose();
      await repository.close();
    },
  };
}

describe("JobScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a job at its time and delivers the final response", async () => {
    const harness = await setup();
    harness.scheduler.start();
    const job = await harness.scheduler.create(DAILY);
    expect(job).toMatchObject({ nextRunAt: "2026-10-11T13:00:00.000Z", runCount: 0, state: "" });

    await harness.advance(59 * MINUTE);
    expect(harness.runs).toEqual([]);
    await harness.advance(MINUTE);
    await vi.waitFor(() => expect(harness.delivered).toHaveLength(1));
    expect(harness.delivered[0]?.text).toBe("Found 2 openings");
    expect(harness.runs[0]?.context.run).toMatchObject({ trigger: "on_time", scheduledAt: "2026-10-11T13:00:00.000Z" });

    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        nextRunAt: "2026-10-12T13:00:00.000Z",
        runCount: 1,
        lastRun: { status: "delivered" },
      });
    });
    expect((await harness.scheduler.listRuns(job.id)).runs).toEqual([
      expect.objectContaining({ status: "delivered", messageId: "message-1", trigger: "on_time" }),
    ]);
    await harness.close();
  });

  it("collapses runs missed while the backend was stopped into one late run", async () => {
    const first = await setup();
    const job = await first.scheduler.create(DAILY);
    await first.close();

    const second = await setup({ directory: first.directory });
    // A week later, at 12:00: seven occurrences were missed.
    await second.advance(7 * 24 * 60 * MINUTE);
    second.scheduler.start();
    await second.advance(0);
    await vi.waitFor(() => expect(second.delivered).toHaveLength(1));
    expect(second.runs[0]?.context.run).toMatchObject({
      trigger: "catch_up",
      scheduledAt: "2026-10-17T13:00:00.000Z",
    });
    expect(await second.scheduler.getJob(job.id)).toMatchObject({ nextRunAt: "2026-10-18T13:00:00.000Z", runCount: 1 });
    await second.close();
  });

  it("finishes silently with skip_delivery and keeps the saved state", async () => {
    const harness = await setup({
      runner: async (_job, context) => {
        await context.saveState('{"seen":["post-1"]}');
        return { kind: "silent", reason: "No new posts" };
      },
    });
    const job = await harness.scheduler.create(DAILY);
    await harness.scheduler.runNow(job.id);
    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        state: '{"seen":["post-1"]}',
        lastRun: { status: "silent" },
        // A manual run does not move the schedule.
        nextRunAt: "2026-10-11T13:00:00.000Z",
        runCount: 0,
      });
    });
    expect(harness.delivered).toEqual([]);
    expect((await harness.scheduler.listRuns(job.id)).runs[0]).toMatchObject({
      trigger: "manual",
      status: "silent",
      skipReason: "No new posts",
    });
    await harness.close();
  });

  it("counts an empty final response as a failure", async () => {
    const harness = await setup({ runner: async () => ({ kind: "message", text: "  " }) });
    const job = await harness.scheduler.create(DAILY);
    await harness.scheduler.runNow(job.id);
    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        lastRun: { status: "failed", errorCode: "empty_response" },
        consecutiveFailures: 1,
      });
    });
    await harness.close();
  });

  it("keeps a failed delivery apart from the run and does not repeat the run", async () => {
    const harness = await setup({
      deliver: async () => {
        throw new WispBackendError("unavailable", "The conversation is unavailable.", true);
      },
    });
    harness.scheduler.start();
    const job = await harness.scheduler.create(DAILY);
    await harness.advance(60 * MINUTE);
    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        lastRun: { status: "failed", deliveryErrorCode: "unavailable" },
        nextRunAt: "2026-10-12T13:00:00.000Z",
      });
    });
    expect((await harness.scheduler.getJob(job.id)).lastRun).not.toHaveProperty("errorCode");
    expect(await harness.scheduler.getJob(job.id)).not.toHaveProperty("retry");
    await harness.close();
  });

  it("retries a failure that may pass, 5 and then 15 minutes later", async () => {
    const harness = await setup({
      runner: async () => {
        throw new WispBackendError("model_unavailable", "The provider is rate limiting requests.", true);
      },
    });
    harness.scheduler.start();
    const job = await harness.scheduler.create(DAILY);
    await harness.advance(60 * MINUTE);
    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        nextRunAt: "2026-10-11T13:05:00.000Z",
        retry: { attempt: 1, scheduledAt: "2026-10-11T13:00:00.000Z" },
        consecutiveFailures: 0,
      });
    });

    await harness.advance(5 * MINUTE);
    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        nextRunAt: "2026-10-11T13:20:00.000Z",
        retry: { attempt: 2 },
      });
    });
    expect(harness.runs[1]?.context.run).toMatchObject({ trigger: "retry", scheduledAt: "2026-10-11T13:00:00.000Z" });

    // The second retry fails too: the occurrence counts as failed, and the job waits for tomorrow.
    await harness.advance(15 * MINUTE);
    await vi.waitFor(async () => {
      const current = await harness.scheduler.getJob(job.id);
      expect(current).toMatchObject({ nextRunAt: "2026-10-12T13:00:00.000Z", consecutiveFailures: 1, runCount: 1 });
      expect(current).not.toHaveProperty("retry");
    });
    expect(harness.runs).toHaveLength(3);
    await harness.close();
  });

  it("does not retry failures that will not pass, and pauses after three failed occurrences", async () => {
    const harness = await setup({
      runner: async () => {
        throw new WispBackendError("invalid_configuration", "No model is configured.");
      },
    });
    harness.scheduler.start();
    const job = await harness.scheduler.create(DAILY);
    for (let day = 0; day < 3; day += 1) {
      await harness.advance(day === 0 ? 60 * MINUTE : 24 * 60 * MINUTE);
      await vi.waitFor(() => expect(harness.runs).toHaveLength(day + 1));
      await vi.waitFor(async () => expect((await harness.scheduler.getJob(job.id)).consecutiveFailures).toBe(day + 1));
    }
    expect(await harness.scheduler.getJob(job.id)).toMatchObject({ paused: { reason: "failures" } });
    expect(harness.notices).toEqual([expect.stringContaining('"Job openings" failed 3 times in a row')]);

    // Paused jobs do not run.
    await harness.advance(24 * 60 * MINUTE);
    expect(harness.runs).toHaveLength(3);

    // Resuming starts over from now.
    harness.setRunner(async () => ({ kind: "message", text: "Back again" }));
    const resumed = await harness.scheduler.resume(job.id);
    expect(resumed).toMatchObject({ consecutiveFailures: 0, nextRunAt: "2026-10-15T13:00:00.000Z" });
    expect(resumed).not.toHaveProperty("paused");
    await harness.close();
  });

  it("stops a run that takes too long", async () => {
    const harness = await setup({
      runner: (_job, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason));
        }),
    });
    const job = await harness.scheduler.create(DAILY);
    await harness.scheduler.runNow(job.id);
    await expect(harness.scheduler.runNow(job.id)).rejects.toMatchObject({ code: "invalid_request" });
    await harness.advance(15 * MINUTE);
    await vi.waitFor(async () => {
      expect(await harness.scheduler.getJob(job.id)).toMatchObject({
        lastRun: { status: "failed", errorCode: "timed_out" },
      });
    });
    expect(harness.scheduler.isRunning(job.id)).toBe(false);
    await harness.close();
  });

  it("runs two jobs at once at most, and skips an occurrence while the job is still running", async () => {
    const releases: Array<() => void> = [];
    const harness = await setup({
      runner: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ kind: "message", text: "Done" }));
        }),
    });
    const soon: NewJob = { ...DAILY, schedule: { kind: "daily", time: "12:10" } };
    const jobs = [
      await harness.scheduler.create(soon),
      await harness.scheduler.create({ ...soon, title: "Blogs" }),
      await harness.scheduler.create({ ...soon, title: "News" }),
    ];
    for (const job of jobs) await harness.scheduler.runNow(job.id);
    await vi.waitFor(() => expect(harness.runs).toHaveLength(2));
    expect(jobs.every(({ id }) => harness.scheduler.isRunning(id))).toBe(true);

    // All three are still going or waiting at 12:10, so their occurrences are skipped.
    harness.scheduler.start();
    await harness.advance(10 * MINUTE);
    await vi.waitFor(async () => {
      expect((await harness.scheduler.listRuns(jobs[0]!.id)).runs[0]).toMatchObject({ status: "skipped" });
    });

    releases[0]!();
    await vi.waitFor(() => expect(harness.runs).toHaveLength(3));
    expect(harness.runs[2]?.job.title).toBe("News");
    for (const release of releases.slice(1)) release();
    await vi.waitFor(() => expect(harness.delivered).toHaveLength(3));
    await harness.close();
  });

  it("changes, pauses and deletes jobs", async () => {
    const harness = await setup();
    const job = await harness.scheduler.create(DAILY);
    const updated = await harness.scheduler.update(job.id, {
      title: "Openings",
      schedule: { kind: "weekly", weekdays: [6], time: "09:00" },
    });
    expect(updated).toMatchObject({ title: "Openings", nextRunAt: "2026-10-17T09:00:00.000Z", tools: ["web_search"] });
    // A job runs without memory until the person turns it on (SWE-248).
    expect(job).not.toHaveProperty("useMemory");
    expect(await harness.scheduler.setMemory(job.id, true)).toMatchObject({ useMemory: true });
    expect(await harness.scheduler.update(job.id, { title: "Openings again" })).toMatchObject({ useMemory: true });
    expect(await harness.scheduler.setMemory(job.id, false)).not.toHaveProperty("useMemory");
    await expect(harness.scheduler.setMemory("missing", true)).rejects.toMatchObject({ code: "not_found" });
    expect(await harness.scheduler.pause(job.id)).toMatchObject({ paused: { reason: "person" } });
    // Pausing twice changes nothing.
    expect(await harness.scheduler.pause(job.id)).toMatchObject({ paused: { reason: "person" } });
    await harness.scheduler.delete(job.id);
    expect((await harness.scheduler.getView()).jobs).toEqual([]);
    await expect(harness.scheduler.delete(job.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      harness.scheduler.create({ ...DAILY, schedule: { kind: "once", at: "2026-10-01T00:00:00.000Z" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(harness.views.at(-1)).toEqual({ jobs: [] });
    await harness.close();
  });
});

describe("claiming occurrences", () => {
  const base: Job = {
    id: "job",
    conversationId: "atlas",
    title: "Job",
    instructions: "Do it.",
    skills: [],
    tools: [],
    schedule: { kind: "daily", time: "13:00" },
    timeZone: "UTC",
    nextRunAt: "2026-10-11T13:00:00.000Z",
    state: "",
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: START.toISOString(),
    updatedAt: START.toISOString(),
  };

  it("still runs a one-off job that was missed, and then ends", () => {
    const once: Job = { ...base, schedule: { kind: "once", at: "2026-10-11T13:00:00.000Z" } };
    const claim = claimOccurrence(once, new Date("2026-10-13T08:00:00.000Z"));
    expect(claim).toMatchObject({ trigger: "catch_up", scheduledAt: "2026-10-11T13:00:00.000Z" });
    expect(claim.job).not.toHaveProperty("nextRunAt");
  });

  it("drops a retry when the next occurrence is due as well", () => {
    const retrying: Job = {
      ...base,
      runCount: 1,
      nextRunAt: "2026-10-11T13:05:00.000Z",
      retry: { attempt: 1, scheduledAt: "2026-10-11T13:00:00.000Z" },
    };
    const claim = claimOccurrence(retrying, new Date("2026-10-12T14:00:00.000Z"));
    expect(claim).toMatchObject({ trigger: "catch_up", scheduledAt: "2026-10-12T13:00:00.000Z" });
    expect(claim.job).toMatchObject({ nextRunAt: "2026-10-13T13:00:00.000Z", runCount: 2 });
    expect(claim.job).not.toHaveProperty("retry");
  });

  it("ends a schedule after its number of runs", () => {
    const twice: Job = { ...base, schedule: { kind: "daily", time: "13:00", end: { kind: "count", count: 2 } } };
    const first = claimOccurrence(twice, new Date("2026-10-11T13:00:00.000Z"));
    expect(first.job).toMatchObject({ runCount: 1, nextRunAt: "2026-10-12T13:00:00.000Z" });
    const second = claimOccurrence(first.job, new Date("2026-10-12T13:00:00.000Z"));
    expect(second.job.runCount).toBe(2);
    expect(second.job).not.toHaveProperty("nextRunAt");
  });
});
