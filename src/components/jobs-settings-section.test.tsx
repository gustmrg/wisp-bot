import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { JobsSettingsSection } from "@/components/jobs-settings-section";
import type { Job, JobsView } from "../../shared/jobs";

const JOB: Job = {
  id: "job-1",
  conversationId: "atlas",
  title: "Job openings",
  instructions: "Search the boards.",
  skills: [],
  tools: ["web_search"],
  schedule: { kind: "daily", time: "10:00" },
  timeZone: "America/Sao_Paulo",
  nextRunAt: "2026-10-12T13:00:00.000Z",
  state: "",
  runCount: 3,
  consecutiveFailures: 0,
  lastRun: { runId: "run-3", status: "delivered", endedAt: "2026-10-11T13:02:00.000Z" },
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-11T13:02:00.000Z",
};

function stub(jobs: Job[]) {
  let view: JobsView = { jobs };
  const api = {
    getJobs: vi.fn(async () => ({ ok: true, value: view })),
    subscribeToJobs: vi.fn(() => () => undefined),
    pauseJob: vi.fn(async () => {
      view = { jobs: view.jobs.map((job) => ({ ...job, paused: { reason: "person", at: job.updatedAt } })) };
      return { ok: true, value: view };
    }),
    resumeJob: vi.fn(async () => ({ ok: true, value: view })),
    runJobNow: vi.fn(async () => ({ ok: true, value: view })),
    deleteJob: vi.fn(async () => ({ ok: true, value: { jobs: [] } })),
    getJobRuns: vi.fn(async () => ({
      ok: true,
      value: {
        jobId: "job-1",
        runs: [
          {
            id: "run-3",
            jobId: "job-1",
            conversationId: "atlas",
            trigger: "catch_up",
            scheduledAt: "2026-10-11T13:00:00.000Z",
            startedAt: "2026-10-11T13:30:00.000Z",
            endedAt: "2026-10-11T13:32:00.000Z",
            status: "silent",
            skipReason: "No new openings",
            usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000 },
          },
        ],
      },
    })),
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

describe("JobsSettingsSection", () => {
  it("lists each Wisp's jobs with their schedule, next run and last run", async () => {
    stub([JOB]);
    render(<JobsSettingsSection wisps={[{ id: "atlas", name: "Atlas" }]} />);
    expect(await screen.findByText("Job openings")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeVisible();
    expect(screen.getByText("Every day at 10:00 (America/Sao_Paulo)")).toBeVisible();
    expect(screen.getByText(/^Next run /)).toBeVisible();
    expect(screen.getByText(/^Last run .*: Delivered$/)).toBeVisible();
  });

  it("pauses, runs, shows the runs of, and deletes a job", async () => {
    const api = stub([JOB]);
    const user = userEvent.setup();
    render(<JobsSettingsSection wisps={[{ id: "atlas", name: "Atlas" }]} />);
    await screen.findByText("Job openings");

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(api.pauseJob).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(await screen.findByRole("button", { name: "Resume" })).toBeVisible();
    expect(screen.getByText("Paused")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Run now" }));
    expect(api.runJobNow).toHaveBeenCalledWith({ jobId: "job-1" });

    await user.click(screen.getByRole("button", { name: "Runs" }));
    const runs = await screen.findByRole("list", { name: "Recent runs of Job openings" });
    expect(within(runs).getByText("Nothing to report")).toBeVisible();
    expect(within(runs).getByText("Caught up · 30 min late · No new openings · 1,000 tokens")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Delete Job openings" }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete job" }));
    expect(api.deleteJob).toHaveBeenCalledWith({ jobId: "job-1" });
    await waitFor(() => expect(screen.getByText("No jobs yet.")).toBeVisible());
  });
});
