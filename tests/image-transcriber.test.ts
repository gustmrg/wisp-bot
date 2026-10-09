import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageTranscriber, type AuxiliaryUsageEntry } from "../backend/image-transcriber.js";
import { TranscriptionCache } from "../backend/transcription-cache.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const model = { provider: "openai", id: "vision", name: "Vision" };
const usage = {
  input: 1_200,
  output: 300,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_500,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

type Reply = { stopReason?: string; text?: string; usage?: typeof usage } | "never" | Error;

async function setup(replies: (index: number) => Reply, options: { deadlineMs?: number; concurrency?: number } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-transcriber-"));
  directories.push(directory);
  const recorded: AuxiliaryUsageEntry[] = [];
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const completeSimple = vi.fn(async (_model: unknown, _context: unknown, request: { signal: AbortSignal }) => {
    const reply = replies(calls++);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (reply instanceof Error) throw reply;
      if (reply === "never") {
        return await new Promise<never>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        role: "assistant",
        content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
        stopReason: reply.stopReason ?? "stop",
        usage: reply.usage ?? usage,
      };
    } finally {
      active -= 1;
    }
  });
  const getSelection = vi.fn(async () => ({ providerId: "openai", modelId: "vision" }));
  const transcriber = new ImageTranscriber({
    getSelection,
    runtime: {
      getModel: vi.fn(() => model),
      getProvider: vi.fn(() => ({ name: "OpenAI" })),
      completeSimple,
    } as never,
    cache: new TranscriptionCache(path.join(directory, "cache")),
    recordUsage: (entry) => recorded.push(entry),
    ...options,
  });
  return { transcriber, completeSimple, recorded, getSelection, maxActive: () => maxActive };
}

const image = vi.fn(async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }));
const request = (page?: number) => ({ key: { contentHash: "hash", ...(page ? { page } : {}) }, image });

describe("ImageTranscriber", () => {
  it("does nothing while the image task is off", async () => {
    const { transcriber, getSelection } = await setup(() => ({ text: "x" }));
    getSelection.mockResolvedValueOnce(null);
    await expect(transcriber.start()).resolves.toBeNull();
  });

  it("transcribes, records usage without content, and answers again from the cache", async () => {
    const { transcriber, completeSimple, recorded } = await setup(() => ({ text: "Invoice 42" }));
    const run = (await transcriber.start())!;
    expect(run.label).toBe("Vision (OpenAI)");

    await expect(run.transcribe([request(1)])).resolves.toEqual([
      { status: "done", text: "Invoice 42", cached: false },
    ]);
    await expect(run.transcribe([request(1)])).resolves.toEqual([{ status: "done", text: "Invoice 42", cached: true }]);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    const [, context, callOptions] = completeSimple.mock.calls[0]!;
    expect(JSON.stringify(context)).toContain("aW1hZ2U=");
    expect(callOptions).toMatchObject({ maxTokens: 4_096 });
    expect(recorded).toEqual([
      { version: 1, task: "imageUnderstanding", providerId: "openai", modelId: "vision", outcome: "ok", usage },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("Invoice");
  });

  it("records a failed call that still reported usage, and reports the failure", async () => {
    const { transcriber, recorded } = await setup((index) =>
      index === 0 ? { stopReason: "error", usage } : new Error("network down"),
    );
    const run = (await transcriber.start())!;

    await expect(run.transcribe([request(1), request(2)])).resolves.toEqual([
      { status: "failed" },
      { status: "failed" },
    ]);
    expect(recorded.map(({ outcome }) => outcome)).toEqual(["error"]);
  });

  it("runs a few calls at a time and marks what the shared deadline cut off", async () => {
    const { transcriber, maxActive } = await setup((index) => (index < 3 ? { text: `page ${index}` } : "never"), {
      deadlineMs: 200,
      concurrency: 3,
    });
    const run = (await transcriber.start())!;

    const outcomes = await run.transcribe([1, 2, 3, 4, 5].map(request));

    expect(maxActive()).toBeLessThanOrEqual(3);
    expect(outcomes.slice(0, 3).map(({ status }) => status)).toEqual(["done", "done", "done"]);
    expect(outcomes.slice(3)).toEqual([{ status: "timed_out" }, { status: "timed_out" }]);
  });

  it("throws when the turn is aborted", async () => {
    const { transcriber } = await setup(() => "never");
    const run = (await transcriber.start())!;
    const controller = new AbortController();
    const pending = run.transcribe([request(1)], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Operation aborted");
  });

  it("notes a transcription cut at the output limit", async () => {
    const { transcriber } = await setup(() => ({ text: "Partial", stopReason: "length" }));
    const run = (await transcriber.start())!;
    const [outcome] = await run.transcribe([request()]);
    expect(outcome).toMatchObject({ status: "done", text: expect.stringContaining("output limit") });
  });
});
