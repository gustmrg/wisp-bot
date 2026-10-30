import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendDecisionUsage,
  CircleRouter,
  routingContext,
  type CircleRoutingInput,
} from "../backend/circle-router.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { buildSessionReport } from "../backend/pi-session-report.js";
import { SessionReportService } from "../backend/session-report-service.js";
import { addModelUsage, type ModelUsage } from "../backend/usage-report.js";
import type { Chat } from "../shared/conversations.js";
import { seedConversations } from "./helpers/seed-conversations.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const INPUT: CircleRoutingInput = {
  conversationId: "crew",
  circle: { name: "Crew", description: "Ship the launch" },
  members: [
    { id: "atlas-id", name: "Atlas", role: "Planning", soul: "Plans the work." },
    { id: "nova-id", name: "Nova", role: "", soul: "Writes the code." },
  ],
  transcript: [{ speaker: "Ada (the user)", text: "Hi" }],
  text: "Fix this bug",
};

const USAGE = {
  input: 120,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};

function answer(choice: string, probability: number, extra: Record<string, unknown> = {}) {
  return {
    stopReason: "stop",
    answers: {
      responder: { type: "choice", choice, probabilities: { [choice]: probability }, confidence: probability },
    },
    ...extra,
  };
}

function createRouter(
  classify: (...args: never[]) => Promise<unknown>,
  options: { off?: boolean; timeoutMs?: number } = {},
) {
  const recordUsage = vi.fn(async () => undefined);
  const onFailed = vi.fn();
  const runtime = { getModelOfType: vi.fn(() => ({ id: "jev" })), classify: vi.fn(classify) };
  const router = new CircleRouter({
    getSelection: async () => (options.off ? null : { providerId: "typesafe", modelId: "jev" }),
    runtime: runtime as never,
    recordUsage,
    onFailed,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { router, runtime, recordUsage, onFailed };
}

const choose = (router: CircleRouter, signal = new AbortController().signal) => router.choose(INPUT, signal);

describe("CircleRouter", () => {
  it("chooses the member the model is sure of, by its ID", async () => {
    const { router } = createRouter(async () => answer("member_2", 0.6));

    await expect(choose(router)).resolves.toBe("nova-id");
  });

  it("leaves the message to the lead below the threshold", async () => {
    const { router } = createRouter(async () => answer("member_2", 0.59));

    await expect(choose(router)).resolves.toBeNull();
  });

  it("ignores an option it did not offer", async () => {
    const { router } = createRouter(async () => answer("member_9", 0.99));

    await expect(choose(router)).resolves.toBeNull();
  });

  it("calls no model while the task is off", async () => {
    const { router, runtime } = createRouter(async () => answer("member_2", 0.9), { off: true });

    await expect(choose(router)).resolves.toBeNull();
    expect(runtime.classify).not.toHaveBeenCalled();
  });

  it("leaves the message to the lead when the model reports an error, and still records what it billed", async () => {
    const { router, recordUsage, onFailed } = createRouter(async () => ({
      stopReason: "error",
      answers: {},
      usage: USAGE,
    }));

    await expect(choose(router)).resolves.toBeNull();
    expect(onFailed).toHaveBeenCalledWith("crew");
    expect(recordUsage).toHaveBeenCalledWith("crew", expect.objectContaining({ task: "decision", outcome: "error" }));
  });

  it("leaves the message to the lead when the call throws", async () => {
    const { router, onFailed } = createRouter(async () => Promise.reject(new Error("offline")));

    await expect(choose(router)).resolves.toBeNull();
    expect(onFailed).toHaveBeenCalledWith("crew");
  });

  it("does not wait past the timeout for a model that never answers", async () => {
    const { router, onFailed } = createRouter(() => new Promise(() => undefined), { timeoutMs: 5 });

    await expect(choose(router)).resolves.toBeNull();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("stops asking when the message is stopped, passing the signal on", async () => {
    let seen: AbortSignal | undefined;
    const { router } = createRouter(((_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
      seen = options.signal;
      return new Promise(() => undefined);
    }) as never);
    const stop = new AbortController();

    const choosing = choose(router, stop.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    stop.abort();

    await expect(choosing).resolves.toBeNull();
    expect(seen?.aborted).toBe(true);
  });

  it("lets a call that comes too late finish, records it, and ignores its choice", async () => {
    let finish: (value: unknown) => void = () => undefined;
    let seen: AbortSignal | undefined;
    const { router, recordUsage } = createRouter(
      ((_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        seen = options.signal;
        return new Promise((resolve) => (finish = resolve));
      }) as never,
      { timeoutMs: 5 },
    );

    await expect(choose(router)).resolves.toBeNull();
    expect(seen?.aborted).toBe(false);
    finish(answer("member_2", 0.9, { usage: USAGE }));

    await vi.waitFor(() => expect(recordUsage).toHaveBeenCalled());
  });
});

describe("routingContext", () => {
  it("names members by option, with a role only when there is one, and keeps their IDs from the model", () => {
    const { context, optionIds } = routingContext(INPUT);

    expect(context.questions.responder).toMatchObject({
      type: "choice",
      criteria: { member_1: "Atlas (Planning). Plans the work.", member_2: "Nova. Writes the code." },
    });
    expect(JSON.stringify(context)).not.toContain("nova-id");
    expect(optionIds.get("member_2")).toBe("nova-id");
    expect(context.state).toMatchObject({ newMessage: "Fix this bug", recentMessages: INPUT.transcript });
  });

  it("reads the start of each soul, less of each in a large circle", () => {
    const soul = "x".repeat(5_000);
    const member = (id: string) => ({ id, name: id, role: "", soul });
    const criteria = (count: number) =>
      Object.values(
        (
          routingContext({ ...INPUT, members: Array.from({ length: count }, (_, i) => member(`w${i}`)) }).context
            .questions.responder as { criteria: Record<string, string> }
        ).criteria,
      )[0]!;

    expect(criteria(2).length).toBeLessThan(1_520);
    expect(criteria(2).length).toBeGreaterThan(1_500);
    expect(criteria(10).length).toBeLessThan(620);
  });

  it("keeps the newest messages within its limit", () => {
    const { context } = routingContext({
      ...INPUT,
      transcript: [
        { speaker: "Old", text: "a".repeat(4_000) },
        { speaker: "New", text: "b".repeat(3_000) },
      ],
    });

    const { recentMessages } = context.state as { recentMessages: Array<{ speaker: string; text: string }> };
    expect(recentMessages.map(({ speaker }) => speaker)).toEqual(["Old", "New"]);
    expect(recentMessages.map(({ text }) => text).join("").length).toBe(4_000);
    expect(recentMessages[1]?.text).toBe("b".repeat(3_000));
  });
});

describe("decision usage", () => {
  it("is a row of its own in a circle's report and the app's, only once it was used", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-decision-report-"));
    directories.push(directory);
    const repository = new ConversationRepository({ dataDirectory: directory });
    const base = {
      label: "Test",
      description: "",
      notifyOnUpdatesEnabled: true,
      preview: "Ready",
      messages: [],
    };
    await seedConversations(repository, {
      // Named like the row: only what it used decides whether a row shows.
      atlas: { ...base, id: "atlas", name: "Decision model", kind: "wisp" } as unknown as Chat,
      crew: { ...base, id: "crew", name: "Crew", kind: "circle", memberIds: ["atlas"] } as unknown as Chat,
    });
    const service = new SessionReportService(repository, {
      ensureFresh: async () => undefined,
      getUpdatedAt: () => null,
      getPricing: () => null,
    } as never);
    const request = { period: "all" as const };
    const names = async (conversationId?: string) =>
      (await service.getUsageReport(conversationId ? { ...request, conversationId } : request)).wisps.map(
        ({ conversationId: id }) => id,
      );

    await expect(names()).resolves.toEqual(["atlas"]);
    await expect(names("crew")).resolves.toEqual(["atlas"]);

    await appendDecisionUsage(repository.circleDecisionUsageDirectory("crew"), {
      version: 1,
      task: "decision",
      providerId: "typesafe",
      modelId: "jev",
      outcome: "ok",
      usage: USAGE as never,
    });

    await expect(names()).resolves.toEqual(["atlas", "decision-model"]);
    await expect(names("crew")).resolves.toEqual(["atlas", "crew"]);
    const report = await service.getUsageReport({ ...request, conversationId: "crew" });
    expect(report.totals.totalTokens).toBe(120);
    expect(report.models?.[0]).toMatchObject({ modelId: "jev", decisionCalls: 1 });
    expect(report.wisps.at(-1)).toMatchObject({ name: "Decision model", decisionModel: true });
  });

  it("is stored without content and counted as decisions in usage reports", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-decision-usage-"));
    directories.push(directory);
    const target = path.join(directory, "nested");

    await appendDecisionUsage(target, {
      version: 1,
      task: "decision",
      providerId: "typesafe",
      modelId: "jev",
      outcome: "ok",
      usage: USAGE as never,
    });

    const contents = await readFile(path.join(target, "usage.jsonl"), "utf8");
    const entry = JSON.parse(contents.trim());
    expect(entry).toMatchObject({ type: "custom", customType: "wisp:auxiliary-usage" });
    const report = buildSessionReport("usage", [entry], {
      workspaceDirectory: "",
      getPricing: () => null,
      getCatalogPricing: () => null,
    } as never);
    expect(report.totals.totalTokens).toBe(120);
    const models: ModelUsage = new Map();
    addModelUsage(models, report);
    expect([...models.values()][0]).toMatchObject({ modelId: "jev", turns: 0, auxiliaryCalls: 0, decisionCalls: 1 });
  });
});
