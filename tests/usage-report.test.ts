import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeFallbackEntry, claudeCodeUsageEntry } from "../backend/claude-code/claude-code-usage-log.js";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { SessionReportService } from "../backend/session-report-service.js";
import { ModelPricingService } from "../backend/model-pricing-service.js";
import type { Chat, CircleChat } from "../shared/conversations.js";
import { seedConversations } from "./helpers/seed-conversations.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function chat(id: string): Chat {
  return {
    id,
    name: id,
    kind: "wisp",
    label: "Test",
    description: "Test",
    notifyOnUpdatesEnabled: true,
    preview: "",
    timestamp: "Now",
    messages: [],
  };
}
function entry(timestamp: string, model = "test/model") {
  return {
    type: "message",
    id: timestamp,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      provider: "openrouter",
      model,
      content: [{ type: "text", text: "PRIVATE PROMPT" }],
      stopReason: "stop",
      usage: { input: 1000, output: 200, cacheRead: 100, cacheWrite: 50, totalTokens: 1350 },
    },
  };
}
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-usage-"));
  directories.push(directory);
  const repository = new ConversationRepository({ dataDirectory: directory });
  await seedConversations(repository, { first: chat("first"), second: chat("second") });
  const pricing = new ModelPricingService({
    cacheFilePath: path.join(directory, "pricing.json"),
    fetchModels: async () => ({
      data: [
        {
          id: "test/model",
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            input_cache_read: "0.0000001",
            input_cache_write: "0.000002",
          },
        },
      ],
    }),
  });
  return { directory, repository, pricing, service: new SessionReportService(repository, pricing) };
}

describe("usage history", () => {
  it("aggregates all saved sessions by Wisp after restart, filters turns by period, and does not double count refreshes", async () => {
    const { directory, repository, pricing, service } = await setup();
    const first = repository.getAgentContext("first");
    const second = repository.getAgentContext("second");
    const recent = new Date(Date.now() - 1000).toISOString();
    const older = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await writeFile(path.join(first.sessionDirectory, "old.jsonl"), `${JSON.stringify(entry(older))}\n`);
    await writeFile(path.join(first.sessionDirectory, "current.jsonl"), `${JSON.stringify(entry(recent))}\n`);
    await writeFile(path.join(second.sessionDirectory, "current.jsonl"), `${JSON.stringify(entry(recent))}\n`);
    const all = await service.getUsageReport({ period: "all" });
    expect(all.totals.totalTokens).toBe(4050);
    expect(all.totals.costUsd).toBeCloseTo(0.00453);
    // Each turn: 100 cached tokens save $0.9/M, 50 written cost $1/M over input.
    expect(all.totals.cacheSavingsUsd).toBeCloseTo(3 * (0.00009 - 0.00005), 12);
    expect(all.wisps.map((row) => row.sessions)).toEqual([2, 1]);
    expect(JSON.stringify(all)).not.toContain("PRIVATE");
    expect(all.pricingUpdatedAt).not.toBeNull();
    expect((await service.getUsageReport({ period: "7d" })).totals.totalTokens).toBe(2700);
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    const restoredService = new SessionReportService(restored, pricing);
    expect((await restoredService.getUsageReport({ period: "all" })).totals).toEqual(all.totals);
    expect((await restoredService.getUsageReport({ period: "all" })).totals).toEqual(all.totals);
  });

  it("splits usage by model for each Wisp and for every Wisp, adding up to the totals", async () => {
    const { repository, service } = await setup();
    const first = repository.getAgentContext("first");
    const second = repository.getAgentContext("second");
    const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    const compaction = {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: at(15),
      summary: "Summary",
      firstKeptEntryId: "kept",
      tokensBefore: 9000,
      usage: {
        input: 900,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1000,
        cost: { input: 0.009, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      },
    };
    await writeFile(
      path.join(first.sessionDirectory, "current.jsonl"),
      [entry(at(30)), entry(at(20), "other/model"), compaction, entry(at(10))]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    await writeFile(path.join(second.sessionDirectory, "current.jsonl"), `${JSON.stringify(entry(at(10)))}\n`);

    const report = await service.getUsageReport({ period: "all" });
    const summary = (rows: typeof report.models) =>
      rows?.map(({ key, kind, turns, totals }) => [key, kind, turns, totals.totalTokens, totals.costUsd]);

    expect(summary(report.wisps[0]!.models)).toEqual([
      ["openrouter:test/model", "model", 2, 2700, expect.closeTo(0.00302, 8)],
      ["openrouter:other/model", "model", 1, 1350, null],
      ["compaction", "compaction", 0, 1000, 0.01],
    ]);
    expect(summary(report.models)).toEqual([
      ["openrouter:test/model", "model", 3, 4050, expect.closeTo(0.00453, 8)],
      ["openrouter:other/model", "model", 1, 1350, null],
      ["compaction", "compaction", 0, 1000, 0.01],
    ]);
    expect(report.models?.reduce((sum, row) => sum + row.totals.totalTokens, 0)).toBe(report.totals.totalTokens);
    expect(report.models?.[0]?.totals.cacheSavingsUsd).toBeCloseTo(3 * (0.00009 - 0.00005), 12);
    expect(report.models?.[2]?.totals.cacheSavingsUsd).toBe(0);
    // An unpriced model keeps the totals' cost unknown, as before.
    expect(report.totals.costUsd).toBeNull();
  });

  it("reports a circle's members' usage in that circle alone, one row per member", async () => {
    const { repository, service } = await setup();
    const circle: CircleChat = {
      id: "crew",
      kind: "circle",
      name: "Crew",
      label: "",
      description: "",
      memberIds: ["second", "first"],
      notifyOnUpdatesEnabled: true,
      preview: "",
      messages: [],
    };
    await repository.create(circle);
    const recent = new Date(Date.now() - 1000).toISOString();
    const [second] = repository.getCircleAgentContext("crew").members;
    // The first Wisp's own conversation is not the circle's.
    await writeFile(
      path.join(repository.getAgentContext("first").sessionDirectory, "own.jsonl"),
      `${JSON.stringify(entry(recent))}\n`,
    );
    await writeFile(path.join(second!.sessionDirectory, "circle.jsonl"), `${JSON.stringify(entry(recent))}\n`);

    const report = await service.getUsageReport({ period: "all", conversationId: "crew" });

    expect(report.incomplete).toBe(false);
    expect(
      report.wisps.map(({ conversationId, sessions, totals }) => [conversationId, sessions, totals.totalTokens]),
    ).toEqual([
      ["second", 1, 1350],
      ["first", 0, 0],
    ]);
    expect(report.totals.totalTokens).toBe(1350);
    // Every Wisp's usage still counts its sessions in circles as its own.
    const everyone = await service.getUsageReport({ period: "all" });
    expect(everyone.wisps.map(({ totals }) => totals.totalTokens)).toEqual([1350, 1350]);
    await expect(service.getUsageReport({ period: "all", conversationId: "first" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("does not count a circle member's session as partial before its first turn there", async () => {
    const { repository, service } = await setup();
    await repository.create({
      id: "crew",
      kind: "circle",
      name: "Crew",
      label: "",
      description: "",
      memberIds: ["first"],
      notifyOnUpdatesEnabled: true,
      preview: "",
      messages: [],
    } satisfies CircleChat);
    await rm(repository.getCircleAgentContext("crew").members[0]!.sessionDirectory, { recursive: true });

    const report = await service.getUsageReport({ period: "all", conversationId: "crew" });

    expect(report.incomplete).toBe(false);
    expect(report.wisps).toEqual([expect.objectContaining({ conversationId: "first", sessions: 0 })]);
  });

  it("marks unreadable history as partial and unavailable pricing as unknown", async () => {
    const { repository, service } = await setup();
    const context = repository.getAgentContext("first");
    await writeFile(path.join(context.sessionDirectory, "broken.jsonl"), "{broken");
    await writeFile(
      path.join(context.sessionDirectory, "valid.jsonl"),
      JSON.stringify(entry(new Date(Date.now() - 1000).toISOString(), "unknown")),
    );
    const report = await service.getUsageReport({ period: "30d" });
    expect(report.incomplete).toBe(true);
    expect(report.totals.totalTokens).toBe(1350);
    expect(report.totals.costUsd).toBeNull();
    expect(report.totals.cacheSavingsUsd).toBeNull();
  });

  it("reports a Claude Code Wisp's turns, a plan's at no cost, with the turns its fallback model answered", async () => {
    const { repository, service } = await setup();
    const context = repository.getAgentContext("first");
    const turn = (ok: boolean) => ({
      sessionId: "s",
      ok,
      reply: "",
      errors: [],
      estimatedCostUsd: 0.5,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 50, totalTokens: 1350 },
    });
    const at = (seconds: number) => new Date(Date.now() - seconds * 1000);
    await writeFile(
      path.join(context.sessionDirectory, "claude-code-usage.jsonl"),
      [
        claudeCodeUsageEntry(turn(true), "claude-sonnet-5-5", "subscription", 0.5, at(30)),
        claudeCodeUsageEntry(
          {
            ...turn(false),
            usage: {
              ...turn(false).usage,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
          "claude-sonnet-5-5",
          "subscription",
          null,
          at(20),
        ),
        claudeCodeFallbackEntry("Test model", at(19)),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    const fallbackTurn = path.join(
      context.sessionDirectory,
      "claude-code-fallback",
      "2026-10-19T12-00-00-000Z-abcd1234",
    );
    await mkdir(fallbackTurn, { recursive: true });
    await writeFile(path.join(fallbackTurn, "pi.jsonl"), `${JSON.stringify(entry(at(18).toISOString()))}\n`);

    const report = await service.getSessionReport("first");
    expect(report?.turns).toBe(3);
    expect(report?.models).toEqual([
      expect.objectContaining({
        providerId: "claude-code",
        modelId: "claude-sonnet-5-5",
        turns: 2,
        costUsd: 0,
        plan: true,
      }),
      expect.objectContaining({ providerId: "openrouter", modelId: "test/model", turns: 1 }),
    ]);
    expect(report?.totals.costUsd).toBeCloseTo(0.00151, 8);
    expect(report?.events.map(({ kind }) => kind)).toEqual(["error", "fallback"]);
    const usage = await service.getUsageReport({ period: "all" });
    expect(usage.totals.totalTokens).toBe(2700);
    expect(usage.totals.costUsd).toBeCloseTo(0.00151, 8);
    // A plan's turns are a row of their own, apart from the model's paid turns.
    expect(usage.models?.map(({ key, plan, turns }) => [key, plan ?? false, turns])).toEqual([
      ["plan:claude-code:claude-sonnet-5-5", true, 2],
      ["openrouter:test/model", false, 1],
    ]);
  });

  it("returns no activity before Pi writes its first message", async () => {
    const { repository, service } = await setup();
    const context = repository.getAgentContext("first");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-1",
      sessionFile: path.join(context.sessionDirectory, "missing.jsonl"),
    });
    expect(await service.getSessionReport("first")).toBeNull();
  });
});
