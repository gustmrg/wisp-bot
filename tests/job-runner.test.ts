import { describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import { JobRunner, jobRunPrompt } from "../backend/job-runner.js";
import type { JobRunContext } from "../backend/job-scheduler.js";
import type { PiJobSessionLike } from "../backend/pi-session-factory.js";
import type { JobSessionSpec } from "../backend/wisp-session-plan.js";
import type { UnattendedGrant } from "../backend/tool-authorization-broker.js";
import type { Job, JobRun } from "../shared/jobs.js";

const NOW = new Date("2026-10-12T13:00:30.000Z");

const JOB: Job = {
  id: "job-1",
  conversationId: "atlas",
  title: "Job openings",
  instructions: "Search the boards and report new openings.",
  skills: ["job-search"],
  tools: ["web_search"],
  schedule: { kind: "daily", time: "10:00" },
  timeZone: "America/Sao_Paulo",
  nextRunAt: "2026-10-13T13:00:00.000Z",
  state: '{"seen":["a"]}',
  runCount: 1,
  consecutiveFailures: 0,
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:00:00.000Z",
};

const RUN: JobRun = {
  id: "run-1",
  jobId: "job-1",
  conversationId: "atlas",
  trigger: "on_time",
  scheduledAt: "2026-10-12T13:00:00.000Z",
  startedAt: NOW.toISOString(),
};

const AGENT_CONTEXT = {
  conversationId: "atlas",
  sessionDirectory: "/data/pi-sessions/atlas-session",
} as ConversationAgentContext;

type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

function setup(answer: (tools: Tool[]) => Promise<{ text: string; stopReason?: string; errorMessage?: string }>) {
  const specs: JobSessionSpec[] = [];
  const prompts: string[] = [];
  const grants: UnattendedGrant[] = [];
  let last: { text: string; stopReason?: string; errorMessage?: string } | undefined;
  const session: PiJobSessionLike = {
    sessionFile: "/data/pi-sessions/atlas-session/jobs/job-1/run-1.jsonl",
    getActiveToolNames: () => [],
    prompt: async (text) => {
      prompts.push(text);
      last = await answer(specs.at(-1)!.runTools as unknown as Tool[]);
    },
    lastAssistantMessage: () => last,
    usage: () => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }),
    dispose: vi.fn(),
  };
  const runner = new JobRunner({
    sessionFactory: {
      createJobSession: async (_context, _selection, spec) => {
        specs.push(spec);
        return session;
      },
    },
    getContext: () => AGENT_CONTEXT,
    getSelection: async () => ({ providerId: "provider", modelId: "model" }),
    runUnattended: (grant, run) => {
      grants.push(grant);
      return run();
    },
    now: () => NOW,
  });
  const recorded: Array<Parameters<JobRunContext["recordSession"]>[0]> = [];
  const saved: string[] = [];
  const context: JobRunContext = {
    run: RUN,
    lastRunAt: "2026-10-11T13:02:00.000Z",
    signal: new AbortController().signal,
    saveState: async (state) => {
      saved.push(state);
    },
    recordSession: (details) => recorded.push(details),
  };
  return { runner, session, specs, prompts, grants, recorded, saved, context };
}

describe("JobRunner", () => {
  it("runs the job unattended in its own session and returns the final response", async () => {
    const harness = setup(async () => ({ text: "Found 2 new openings", stopReason: "stop" }));
    await expect(harness.runner.run(JOB, harness.context)).resolves.toEqual({
      kind: "message",
      text: "Found 2 new openings",
    });
    expect(harness.specs[0]).toMatchObject({
      runId: "run-1",
      runDirectory: "/data/pi-sessions/atlas-session/jobs/job-1",
      tools: ["web_search"],
      skills: ["job-search"],
    });
    expect(harness.specs[0]?.runTools.map(({ name }) => name)).toEqual(["skip_delivery", "save_job_state"]);
    expect(harness.grants).toEqual([{ conversationId: "atlas", approvedTools: new Set(["web_search"]) }]);
    expect(harness.prompts[0]).toContain("Search the boards and report new openings.");
    expect(harness.recorded.at(-1)).toEqual({
      sessionFile: "/data/pi-sessions/atlas-session/jobs/job-1/run-1.jsonl",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
    });
    expect(harness.session.dispose).toHaveBeenCalled();
  });

  it("finishes silently with skip_delivery and saves state with save_job_state", async () => {
    const harness = setup(async (tools) => {
      await tools.find(({ name }) => name === "save_job_state")!.execute("call-1", { state: '{"seen":["a","b"]}' });
      await tools.find(({ name }) => name === "skip_delivery")!.execute("call-2", { reason: "No new posts" });
      return { text: "", stopReason: "stop" };
    });
    await expect(harness.runner.run(JOB, harness.context)).resolves.toEqual({ kind: "silent", reason: "No new posts" });
    expect(harness.saved).toEqual(['{"seen":["a","b"]}']);
  });

  it("refuses state over 16 KB", async () => {
    const harness = setup(async (tools) => {
      await tools
        .find(({ name }) => name === "save_job_state")!
        .execute("call-1", { state: "x".repeat(16 * 1024 + 1) });
      return { text: "Done" };
    });
    await expect(harness.runner.run(JOB, harness.context)).rejects.toMatchObject({ code: "invalid_request" });
    expect(harness.saved).toEqual([]);
  });

  it("fails with a retryable error when the provider failed for a reason that may pass", async () => {
    const harness = setup(async () => ({ text: "", stopReason: "error", errorMessage: "429 Too Many Requests" }));
    const error = await harness.runner.run(JOB, harness.context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WispBackendError);
    expect(error).toMatchObject({ retryable: true });
    // The session is kept with the failed run.
    expect(harness.recorded.at(-1)).toHaveProperty("sessionFile");
  });

  it("needs a model", async () => {
    const harness = setup(async () => ({ text: "Done" }));
    const runner = new JobRunner({
      sessionFactory: { createJobSession: vi.fn() },
      getContext: () => AGENT_CONTEXT,
      getSelection: async () => null,
      runUnattended: (_grant, run) => run(),
    });
    await expect(runner.run(JOB, harness.context)).rejects.toMatchObject({ code: "configuration_required" });
  });
});

describe("job run prompts", () => {
  it("says when the run happens, whether it is late, and what the last run left", () => {
    const prompt = jobRunPrompt(JOB, RUN, "2026-10-11T13:02:00.000Z", NOW);
    expect(prompt).toBe(
      [
        '[Scheduled job "Job openings". No one is present.]',
        "It is running on Mon, Oct 12, 2026, 10:00 AM (America/Sao_Paulo), as scheduled.",
        "The job last ran on Sun, Oct 11, 2026, 10:02 AM.",
        "",
        "## Saved state",
        '{"seen":["a"]}',
        "",
        "## Instructions",
        "Search the boards and report new openings.",
      ].join("\n"),
    );
    const late = jobRunPrompt(
      { ...JOB, state: "" },
      { trigger: "catch_up", scheduledAt: "2026-10-10T13:00:00.000Z" },
      undefined,
      NOW,
    );
    expect(late).toContain(
      "It was due on Sat, Oct 10, 2026, 10:00 AM and is running late, on Mon, Oct 12, 2026, 10:00 AM (America/Sao_Paulo), because the app was not running at that time.",
    );
    expect(late).toContain("This is the job's first run.");
    expect(late).toContain("(none yet)");
    expect(late).not.toContain("daily");
  });
});
