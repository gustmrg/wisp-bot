import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AiSettingsStore } from "../backend/ai-settings-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore(): Promise<{ directory: string; filePath: string; store: AiSettingsStore }> {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-ai-settings-"));
  directories.push(directory);
  const filePath = path.join(directory, "ai-settings.json");
  return { directory, filePath, store: new AiSettingsStore(filePath) };
}

describe("AiSettingsStore", () => {
  it("persists and reloads the selected provider and model", async () => {
    const { filePath, store } = await createStore();
    const selection = { providerId: "anthropic", modelId: "claude-example", maxOutputTokens: 16_384 };

    await store.setSelection(selection);

    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toEqual(selection);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      selection,
    });
  });

  it("keeps a chosen thinking level, never stores the default, and never lets auxiliary models reason", async () => {
    const { filePath, store } = await createStore();
    const selection = { providerId: "anthropic", modelId: "claude-example", thinkingLevel: "high" as const };
    await store.setSelection(selection);
    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toEqual(selection);

    const auxiliary = { providerId: "openai", modelId: "vision", thinkingLevel: "high" };
    for (const [thinkingLevel, expected] of [
      ["off", { providerId: "anthropic", modelId: "claude-example" }],
      ["extreme", null],
    ] as const) {
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          selection: { providerId: "anthropic", modelId: "claude-example", thinkingLevel },
          auxiliary: { imageUnderstanding: auxiliary },
        }),
      );
      const reloaded = new AiSettingsStore(filePath);
      await expect(reloaded.getSelection()).resolves.toEqual(expected);
      await expect(reloaded.getAuxiliary()).resolves.toEqual({
        imageUnderstanding: { providerId: "openai", modelId: "vision" },
      });
    }
  });

  it("normalizes unsupported and malformed settings", async () => {
    const { filePath } = await createStore();
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, selection: { providerId: "x", modelId: "y" } }));
    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toBeNull();

    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, selection: { providerId: "", modelId: "y" } }));
    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toBeNull();

    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, selection: { providerId: "x", modelId: "y", maxOutputTokens: 0 } }),
    );
    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toBeNull();
  });

  it("keeps auxiliary models in version 1 next to the main selection", async () => {
    const { filePath, store } = await createStore();
    const selection = { providerId: "anthropic", modelId: "claude-example" };
    const image = { providerId: "openai", modelId: "vision-example" };

    await store.setSelection(selection);
    await store.setAuxiliary("imageUnderstanding", { ...image, maxOutputTokens: 100 });
    await store.setSelection(selection);

    const reloaded = new AiSettingsStore(filePath);
    await expect(reloaded.getSelection()).resolves.toEqual(selection);
    await expect(reloaded.getAuxiliary()).resolves.toEqual({ imageUnderstanding: image });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      selection,
      auxiliary: { imageUnderstanding: image },
    });

    await store.setAuxiliary("imageUnderstanding", null);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ schemaVersion: 1, selection });
  });

  it("keeps the fallback models in version 1, naming only their provider and model", async () => {
    const { filePath, store } = await createStore();
    const selection = { providerId: "anthropic", modelId: "claude-example" };
    const fallback = { providerId: "openrouter", modelId: "backup" };

    await store.setSelection(selection);
    await store.setFallbacks([{ ...fallback, maxOutputTokens: 100, thinkingLevel: "high" }]);

    const reloaded = new AiSettingsStore(filePath);
    await expect(reloaded.getFallbacks()).resolves.toEqual([fallback]);
    await expect(reloaded.getSelection()).resolves.toEqual(selection);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ schemaVersion: 1, selection, fallback });

    await store.setFallbacks([]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ schemaVersion: 1, selection });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, selection, fallback: { providerId: "" } }));
    await expect(new AiSettingsStore(filePath).getFallbacks()).resolves.toEqual([]);
  });

  it("keeps the first fallback where earlier releases read it, and the others after, up to three without repeats", async () => {
    const { filePath, store } = await createStore();
    const selection = { providerId: "anthropic", modelId: "claude-example" };
    const [one, two, three, four] = ["a", "b", "c", "d"].map((id) => ({ providerId: "openrouter", modelId: id }));
    await store.setSelection(selection);
    await store.setFallbacks([one!, two!, one!, three!, four!]);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      selection,
      fallback: one,
      moreFallbacks: [two, three],
    });
    await expect(new AiSettingsStore(filePath).getFallbacks()).resolves.toEqual([one, two, three]);

    // A file an earlier release rewrote keeps its first fallback only; others left without a first are dropped.
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, selection, fallback: one }));
    await expect(new AiSettingsStore(filePath).getFallbacks()).resolves.toEqual([one]);
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, selection, moreFallbacks: [two] }));
    await expect(new AiSettingsStore(filePath).getFallbacks()).resolves.toEqual([]);
  });

  it("reads files without auxiliary models, or with malformed ones, as off", async () => {
    const { filePath } = await createStore();
    const selection = { providerId: "anthropic", modelId: "claude-example" };
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, selection }));
    await expect(new AiSettingsStore(filePath).getAuxiliary()).resolves.toEqual({ imageUnderstanding: null });

    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, selection, auxiliary: { imageUnderstanding: { providerId: "" } } }),
    );
    const store = new AiSettingsStore(filePath);
    await expect(store.getAuxiliary()).resolves.toEqual({ imageUnderstanding: null });
    await expect(store.getSelection()).resolves.toEqual(selection);
  });
});
