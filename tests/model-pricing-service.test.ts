import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelPricingService } from "../backend/model-pricing-service.js";

const OPENROUTER_PAYLOAD = {
  data: [
    {
      id: "openai/gpt-oss-120b",
      pricing: { prompt: "0.0000015", completion: "0.000003", input_cache_read: "0.00000015" },
    },
    { id: "free/model", pricing: { prompt: "0", completion: "0" } },
    { id: "broken/model", pricing: { prompt: "not-a-number" } },
    { id: "no-pricing/model" },
  ],
};

let tempDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-pricing-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirectories = [];
});

function createService(options: {
  directory: string;
  fetchModels?: (url: string, timeoutMs: number) => Promise<unknown>;
  now?: () => Date;
}) {
  return new ModelPricingService({
    cacheFilePath: path.join(options.directory, "model-pricing.json"),
    ...(options.fetchModels ? { fetchModels: options.fetchModels } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("ModelPricingService", () => {
  it("fetches OpenRouter pricing, normalizes it to per-million tokens, and caches it", async () => {
    const directory = await tempDirectory();
    const fetchModels = vi.fn(async () => OPENROUTER_PAYLOAD);
    const service = createService({ directory, fetchModels });

    await service.ensureFresh();

    expect(service.getPricing("openrouter", "openai/gpt-oss-120b")).toEqual({
      inputPerMillionTokens: 1.5,
      outputPerMillionTokens: 3,
      cacheReadPerMillionTokens: 0.15,
    });
    expect(service.getPricing("openrouter", "free/model")).toEqual({
      inputPerMillionTokens: 0,
      outputPerMillionTokens: 0,
      cacheReadPerMillionTokens: 0,
    });
    expect(service.getPricing("openrouter", "broken/model")).toBeNull();
    expect(service.getPricing("openrouter", "no-pricing/model")).toBeNull();
    expect(service.getPricing("anthropic", "claude-3-5-sonnet")).toBeNull();
    expect(fetchModels).toHaveBeenCalledTimes(1);

    const cached = JSON.parse(await readFile(path.join(directory, "model-pricing.json"), "utf8"));
    expect(cached.schemaVersion).toBe(1);
    expect(cached.models["openai/gpt-oss-120b"]).toEqual({
      inputPerMillionTokens: 1.5,
      outputPerMillionTokens: 3,
      cacheReadPerMillionTokens: 0.15,
    });
  });

  it("serves a fresh cache without fetching", async () => {
    const directory = await tempDirectory();
    const fetchModels = vi.fn(async () => OPENROUTER_PAYLOAD);
    const now = vi.fn(() => new Date("2026-09-03T12:00:00.000Z"));
    const first = createService({ directory, fetchModels, now });
    await first.ensureFresh();

    const cached = JSON.parse(await readFile(path.join(directory, "model-pricing.json"), "utf8"));
    const reload = new ModelPricingService({
      cacheFilePath: path.join(directory, "model-pricing.json"),
      fetchModels,
      now,
    });
    await reload.ensureFresh();

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(reload.getPricing("openrouter", "openai/gpt-oss-120b")?.inputPerMillionTokens).toBe(1.5);
    void cached;
  });

  it("keeps serving a stale cache when the fetch fails and retries only after the backoff", async () => {
    const directory = await tempDirectory();
    await writeFile(
      path.join(directory, "model-pricing.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        cachedAt: "2026-09-02T00:00:00.000Z",
        models: {
          "openai/gpt-oss-120b": { inputPerMillionTokens: 2, outputPerMillionTokens: 4, cacheReadPerMillionTokens: 0 },
        },
      })}\n`,
      "utf8",
    );
    const fetchModels = vi.fn(async () => {
      throw new Error("network down");
    });
    const now = vi.fn(() => new Date("2026-09-03T12:00:00.000Z"));
    const service = new ModelPricingService({
      cacheFilePath: path.join(directory, "model-pricing.json"),
      fetchModels,
      now,
      retryDelayMs: 5 * 60 * 1_000,
    });

    await service.ensureFresh();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(service.getPricing("openrouter", "openai/gpt-oss-120b")?.inputPerMillionTokens).toBe(2);

    await service.ensureFresh();
    expect(fetchModels).toHaveBeenCalledTimes(1);

    now.mockImplementation(() => new Date("2026-09-03T12:10:00.000Z"));
    await service.ensureFresh();
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(service.getPricing("openrouter", "openai/gpt-oss-120b")?.inputPerMillionTokens).toBe(2);
  });

  it("returns no pricing when there is no cache and the fetch fails", async () => {
    const directory = await tempDirectory();
    const fetchModels = vi.fn(async () => {
      throw new Error("network down");
    });
    const service = createService({ directory, fetchModels });

    await service.ensureFresh();

    expect(service.getPricing("openrouter", "openai/gpt-oss-120b")).toBeNull();
  });

  it("ignores a corrupt cache file", async () => {
    const directory = await tempDirectory();
    await writeFile(path.join(directory, "model-pricing.json"), "{not json", "utf8");
    const fetchModels = vi.fn(async () => OPENROUTER_PAYLOAD);
    const service = createService({ directory, fetchModels });

    await service.ensureFresh();

    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(service.getPricing("openrouter", "openai/gpt-oss-120b")?.inputPerMillionTokens).toBe(1.5);
  });
});
