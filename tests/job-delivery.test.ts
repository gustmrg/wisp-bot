import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeConversationAgent } from "../backend/fake-conversation-agent.js";
import { jobCardItems, jobResultContext } from "../backend/job-host.js";
import type { ConversationAgentEvent } from "../shared/contracts.js";
import type { Job } from "../shared/jobs.js";
import { setupMessaging } from "./helpers/messaging-harness.js";

const JOB: Job = {
  id: "job-1",
  conversationId: "one",
  title: "Blog watch",
  instructions: "Check the blogs.",
  skills: [],
  tools: ["web_read"],
  schedule: { kind: "weekly", weekdays: [6], time: "09:00" },
  timeZone: "America/Sao_Paulo",
  nextRunAt: "2026-10-10T12:00:00.000Z",
  state: "",
  runCount: 0,
  consecutiveFailures: 0,
  createdAt: "2026-10-06T12:00:00.000Z",
  updatedAt: "2026-10-06T12:00:00.000Z",
};

describe("job delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds the run's message as the Wisp's, unread, and then to the Wisp's context", async () => {
    const harness = await setupMessaging();
    const events: ConversationAgentEvent[] = [];
    vi.spyOn(harness.registry, "publishExternalEvent").mockImplementation((event) => events.push(event));

    const messageId = await harness.service.deliverJobMessage(
      "one",
      "## Saturday\n\nTwo new posts.",
      { jobId: "job-1", runId: "run-1", title: "Blog watch" },
      "[Your job ran]\n\nTwo new posts.",
    );

    expect(messageId).toBe("job-run-1");
    expect((await harness.transcript()).at(-1)).toMatchObject({
      id: "job-run-1",
      type: "incoming",
      text: "## Saturday\n\nTwo new posts.",
      status: "complete",
      authorId: "one",
      job: { jobId: "job-1", runId: "run-1", title: "Blog watch" },
    });
    expect(harness.repository.readChat("one")).toMatchObject({ unread: true, unreadCount: 1 });
    expect(events).toEqual([
      { type: "job_message_delivered", conversationId: "one", jobId: "job-1", messageId: "job-run-1" },
    ]);
    const agent = harness.registry.get("one") as FakeConversationAgent;
    await vi.waitFor(() => expect(agent.jobResults).toEqual(["[Your job ran]\n\nTwo new posts."]));
    await harness.close();
  });

  it("waits for the turn in progress before adding the result to the Wisp's context", async () => {
    const harness = await setupMessaging({ latencyMs: 1_000 });
    const agent = harness.registry.get("one") as FakeConversationAgent;
    const turn = harness.registry.send({ conversationId: "one", requestId: "request-1", text: "Hello" });
    await harness.service.deliverJobMessage(
      "one",
      "Result",
      { jobId: "job-1", runId: "run-2", title: "Blogs" },
      "Note",
    );
    await harness.advance(0);
    expect(agent.jobResults).toEqual([]);
    await harness.advance(1_000);
    await turn;
    await vi.waitFor(() => expect(agent.jobResults).toEqual(["Note"]));
    await harness.close();
  });

  it("leaves notices and cards about jobs in the conversation", async () => {
    const harness = await setupMessaging();
    await harness.service.addJobNotice("one", 'The job "Blog watch" was paused.', "job-notice-1");
    await harness.service.addJobCard("one", jobCardItems(JOB, "created"), "job-card-1");
    const transcript = await harness.transcript();
    expect(transcript.at(-2)).toMatchObject({ type: "time", text: 'The job "Blog watch" was paused.' });
    expect(transcript.at(-1)).toMatchObject({
      type: "card",
      items: [
        { label: "New job", text: "Blog watch" },
        { label: "Schedule", text: "Every Saturday at 09:00 (America/Sao_Paulo)" },
        { label: "Next run", text: "Sat, Oct 10, 2026, 9:00 AM (America/Sao_Paulo)" },
      ],
    });
    await harness.close();
  });

  it("tells the Wisp which of its jobs said what", () => {
    expect(jobResultContext(JOB, "Two new posts.", new Date("2026-10-10T12:03:00.000Z"))).toBe(
      '[Your job "Blog watch" ran on Sat, Oct 10, 2026, 9:03 AM (America/Sao_Paulo) and sent the user this message:]\n\nTwo new posts.',
    );
  });
});
