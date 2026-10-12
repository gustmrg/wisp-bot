import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConversationRepository } from "../backend/conversation-repository.js";
import { normalizeJob, normalizeJobRun } from "../backend/job-records.js";
import type { Chat } from "../shared/conversations.js";
import { MAX_JOB_RUNS_KEPT, type Job, type JobRun } from "../shared/jobs.js";

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
    timestamp: "Now",
    messages: [],
  } as unknown as Chat;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    conversationId: "atlas",
    title: "Job openings",
    instructions: "Search for openings and report the new ones.",
    skills: ["job-search"],
    tools: ["web_search", "run_command"],
    schedule: { kind: "daily", time: "10:00" },
    timeZone: "America/Sao_Paulo",
    nextRunAt: "2026-10-12T13:00:00.000Z",
    state: "",
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

function run(index: number, overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: `run-${index}`,
    jobId: "job-1",
    conversationId: "atlas",
    trigger: "on_time",
    scheduledAt: "2026-10-12T13:00:00.000Z",
    startedAt: "2026-10-12T13:00:01.000Z",
    endedAt: "2026-10-12T13:02:00.000Z",
    status: "delivered",
    ...overrides,
  };
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-jobs-"));
  const repository = new ConversationRepository({ dataDirectory: directory });
  await repository.initialize({ atlas: wispChat("atlas"), echo: wispChat("echo") });
  return { directory, repository };
}

describe("job records", () => {
  it("validates stored jobs and runs", () => {
    expect(normalizeJob(job())).toEqual(job());
    const paused = job({
      paused: { reason: "failures", at: "2026-10-13T13:00:00.000Z" },
      retry: { attempt: 1, scheduledAt: "2026-10-12T13:00:00.000Z" },
      lastRun: { runId: "run-1", status: "failed", endedAt: "2026-10-12T13:02:00.000Z", errorCode: "provider_error" },
    });
    expect(normalizeJob(paused)).toEqual(paused);
    expect(normalizeJob({ ...job(), nextRunAt: undefined })).not.toHaveProperty("nextRunAt");
    expect(normalizeJob({ ...job(), schedule: { kind: "hourly" } })).toBeUndefined();
    expect(normalizeJob({ ...job(), timeZone: "Mars/Olympus" })).toBeUndefined();
    expect(normalizeJob({ ...job(), tools: [""] })).toBeUndefined();
    expect(normalizeJob({ ...job(), paused: { reason: "bored", at: "2026-10-13T13:00:00.000Z" } })).toBeUndefined();

    expect(normalizeJobRun(run(1))).toEqual(run(1));
    expect(normalizeJobRun({ ...run(1), trigger: "whenever" })).toBeUndefined();
    expect(normalizeJobRun({ ...run(1), usage: { inputTokens: -1 } })).toBeUndefined();
  });

  it("stores jobs per Wisp, soonest first, up to a limit", async () => {
    const { directory, repository } = await setup();
    await repository.addJob(job({ id: "later", nextRunAt: "2026-10-20T13:00:00.000Z" }), 2);
    await repository.addJob(job({ id: "ended", nextRunAt: undefined }), 2);
    await expect(repository.addJob(job({ id: "third" }), 2)).rejects.toMatchObject({ code: "invalid_request" });
    await repository.addJob(job({ id: "sooner", conversationId: "echo" }), 2);
    await expect(repository.addJob(job({ id: "lost", conversationId: "missing" }), 2)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(repository.addJob(job({ id: "later", conversationId: "echo" }), 2)).rejects.toMatchObject({
      code: "already_exists",
    });

    expect((await repository.listJobs()).map(({ id }) => id)).toEqual(["sooner", "later", "ended"]);
    await repository.close();
    const reloaded = new ConversationRepository({ dataDirectory: directory });
    await reloaded.load();
    expect(await reloaded.listJobs()).toEqual([
      job({ id: "sooner", conversationId: "echo" }),
      job({ id: "later", nextRunAt: "2026-10-20T13:00:00.000Z" }),
      job({ id: "ended", nextRunAt: undefined }),
    ]);
    await reloaded.close();
  });

  it("changes and deletes a job, keeping it in its conversation", async () => {
    const { repository } = await setup();
    await repository.addJob(job(), 20);
    const previous = await repository.changeJob("job-1", (current) => ({
      ...current,
      conversationId: "echo",
      title: "Openings",
      paused: { reason: "person", at: "2026-10-11T13:00:00.000Z" },
    }));
    expect(previous).toEqual(job());
    expect(await repository.listJobs()).toEqual([
      job({ title: "Openings", paused: { reason: "person", at: "2026-10-11T13:00:00.000Z" } }),
    ]);
    expect(await repository.changeJob("job-1", () => undefined)).toBeUndefined();
    expect(await repository.changeJob("missing", () => null)).toBeUndefined();
    await repository.changeJob("job-1", () => null);
    expect(await repository.listJobs()).toEqual([]);
    await repository.close();
  });

  it("keeps the newest runs of each job and deletes the session files of the rest", async () => {
    const { directory, repository } = await setup();
    await repository.addJob(job(), 20);
    const runDirectory = path.join(directory, "pi-sessions", "runs");
    await mkdir(runDirectory, { recursive: true });
    for (let index = 0; index < MAX_JOB_RUNS_KEPT + 2; index += 1) {
      const sessionFile = path.join(runDirectory, `run-${index}.jsonl`);
      await writeFile(sessionFile, "{}");
      await repository.putJobRun(run(index, { sessionFile }));
    }
    const runs = await repository.listJobRuns("job-1");
    expect(runs).toHaveLength(MAX_JOB_RUNS_KEPT);
    expect(runs[0]?.id).toBe(`run-${MAX_JOB_RUNS_KEPT + 1}`);
    expect((await readdir(runDirectory)).sort()).toEqual(runs.map(({ id }) => `${id}.jsonl`).sort());

    // A run that finishes updates its record in place.
    await repository.putJobRun({ ...runs[0]!, status: "silent", skipReason: "Nothing new" });
    expect((await repository.listJobRuns("job-1", 1))[0]).toMatchObject({
      status: "silent",
      skipReason: "Nothing new",
    });

    // Runs of a job that no longer exists are not recorded, and deleting a job deletes its runs.
    await repository.putJobRun(run(99, { jobId: "missing" }));
    expect(await repository.listJobRuns("missing")).toEqual([]);
    await repository.changeJob("job-1", () => null);
    expect(await repository.listJobRuns("job-1")).toEqual([]);
    expect(await readdir(runDirectory)).toEqual([]);
    await repository.close();
  });

  it("deletes a Wisp's jobs with the Wisp", async () => {
    const { repository } = await setup();
    await repository.addJob(job(), 20);
    await repository.putJobRun(run(1));
    await repository.deleteWisp("atlas");
    expect(await repository.listJobs()).toEqual([]);
    expect(await repository.listJobRuns("job-1")).toEqual([]);
    await repository.close();
  });
});
