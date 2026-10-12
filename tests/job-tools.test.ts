import { describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { NewJob } from "../backend/job-scheduler.js";
import { createJobTools, type JobToolHost } from "../backend/job-tools.js";
import type { ToolAuthorizationRequest } from "../backend/tool-authorization-broker.js";
import type { Job } from "../shared/jobs.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");

type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

function setup(options: { approve?: boolean; jobs?: Job[] } = {}) {
  const jobs: Job[] = options.jobs ?? [];
  const approvals: ToolAuthorizationRequest[] = [];
  const cards: Array<{ job: Job; change: string }> = [];
  let ids = 0;
  const host: JobToolHost = {
    list: async (conversationId) => jobs.filter((job) => job.conversationId === conversationId),
    create: async (request: NewJob) => {
      const job: Job = {
        ...request,
        id: `job-${++ids}`,
        nextRunAt: "2026-10-12T13:00:00.000Z",
        state: "",
        runCount: 0,
        consecutiveFailures: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      jobs.push(job);
      return job;
    },
    update: async (jobId, changes) => {
      const index = jobs.findIndex(({ id }) => id === jobId);
      jobs[index] = { ...jobs[index]!, ...changes } as Job;
      return jobs[index]!;
    },
    delete: async (jobId) => {
      jobs.splice(
        jobs.findIndex(({ id }) => id === jobId),
        1,
      );
    },
    recordChange: async (job, change) => {
      cards.push({ job, change });
    },
  };
  const tools = createJobTools({
    host,
    context: {
      conversationId: "atlas",
      userTimeZone: () => "America/Sao_Paulo",
    } as ConversationAgentContext,
    authorizationBroker: {
      authorize: vi.fn(async (request: ToolAuthorizationRequest) => {
        approvals.push(request);
        if (options.approve === false) throw Object.assign(new Error("denied"), { code: "tool_blocked" });
      }),
    },
    hasSkill: async (name) => name === "job-search",
    availableTools: async () => ["web_search", "web_read", "run_command"],
    now: () => NOW,
  }) as unknown as Tool[];
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return { jobs, approvals, cards, tool };
}

const REQUEST = {
  title: "Job openings",
  instructions: "Search the boards for remote TypeScript roles and list new ones under a dated heading.",
  schedule: { kind: "daily", time: "10:00" },
  skills: ["job-search"],
  tools: ["web_search"],
};

describe("job tools", () => {
  it("schedules a job only after the person approves everything it may do", async () => {
    const harness = setup();
    const result = await harness.tool("schedule_job").execute("call-1", REQUEST);

    expect(harness.approvals).toEqual([
      expect.objectContaining({
        conversationId: "atlas",
        toolCallId: "call-1",
        toolName: "schedule_job",
        category: "schedule_job",
        scope: { kind: "job", value: "Job openings" },
        job: {
          title: "Job openings",
          schedule: "Every day at 10:00 (America/Sao_Paulo)",
          nextRunAt: "2026-10-11T13:00:00.000Z",
          instructions: REQUEST.instructions,
          skills: ["job-search"],
          tools: ["web_search"],
        },
      }),
    ]);
    expect(harness.jobs[0]).toMatchObject({
      conversationId: "atlas",
      timeZone: "America/Sao_Paulo",
      schedule: { kind: "daily", time: "10:00" },
    });
    expect(harness.cards).toEqual([{ job: harness.jobs[0], change: "created" }]);
    expect(result.content[0]?.text).toContain('Scheduled the job "Job openings" (ID job-1)');
  });

  it("creates nothing when the person denies the job", async () => {
    const harness = setup({ approve: false });
    await expect(harness.tool("schedule_job").execute("call-1", REQUEST)).rejects.toThrow("denied");
    expect(harness.jobs).toEqual([]);
    expect(harness.cards).toEqual([]);
  });

  it("refuses tools the Wisp does not have, unknown skills, and bad schedules before asking", async () => {
    const harness = setup();
    await expect(
      harness.tool("schedule_job").execute("call-1", { ...REQUEST, tools: ["linear_create_issue"] }),
    ).rejects.toMatchObject({ code: "invalid_request", message: expect.stringContaining("web_search, web_read") });
    await expect(
      harness.tool("schedule_job").execute("call-2", { ...REQUEST, skills: ["missing"] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      harness.tool("schedule_job").execute("call-3", { ...REQUEST, schedule: { kind: "hourly" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      harness.tool("schedule_job").execute("call-4", {
        ...REQUEST,
        schedule: { kind: "once", at: "2026-10-01T10:00:00-03:00" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(harness.approvals).toEqual([]);
  });

  it("asks again only when a change widens what the job does", async () => {
    const harness = setup();
    await harness.tool("schedule_job").execute("call-1", REQUEST);
    harness.approvals.length = 0;

    await harness.tool("update_job").execute("call-2", {
      job_id: "job-1",
      title: "Openings",
      schedule: { kind: "weekly", weekdays: [1, 3], time: "09:00" },
      tools: [],
    });
    expect(harness.approvals).toEqual([]);
    expect(harness.jobs[0]).toMatchObject({ title: "Openings", tools: [] });
    expect(harness.cards.at(-1)?.change).toBe("updated");

    await harness.tool("update_job").execute("call-3", { job_id: "job-1", tools: ["web_read"] });
    expect(harness.approvals).toHaveLength(1);
    await harness.tool("update_job").execute("call-4", { job_id: "job-1", instructions: "Something else." });
    expect(harness.approvals).toHaveLength(2);
  });

  it("lists and cancels only the jobs of its own conversation", async () => {
    const other: Job = {
      id: "elsewhere",
      conversationId: "echo",
      title: "Not mine",
      instructions: "Nope.",
      skills: [],
      tools: [],
      schedule: { kind: "daily", time: "08:00" },
      timeZone: "UTC",
      state: "",
      runCount: 0,
      consecutiveFailures: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const harness = setup({ jobs: [other] });
    expect((await harness.tool("list_jobs").execute("call-1", {})).content[0]?.text).toBe(
      "There are no jobs in this conversation.",
    );
    await expect(harness.tool("cancel_job").execute("call-2", { job_id: "elsewhere" })).rejects.toMatchObject({
      code: "not_found",
    });
    await harness.tool("schedule_job").execute("call-3", REQUEST);
    const listed = (await harness.tool("list_jobs").execute("call-4", {})).content[0]?.text;
    expect(listed).toContain("Job openings (ID job-1)");
    expect(listed).toContain("Schedule: Every day at 10:00 (America/Sao_Paulo)");
    await harness.tool("cancel_job").execute("call-5", { job_id: "job-1" });
    expect(harness.jobs).toEqual([other]);
  });
});
