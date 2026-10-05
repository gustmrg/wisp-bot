import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { SessionReportService } from "../backend/session-report-service.js";
import { ModelPricingService } from "../backend/model-pricing-service.js";
import type { Chat } from "../shared/conversations.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
function chat(id: string): Chat {
  return {
    id,
    name: id,
    kind: "wisp",
    shape: "circle",
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
  await repository.initialize({ first: chat("first"), second: chat("second") });
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
