import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AiSettingsStore } from "../electron/backend/ai-settings-store.js";

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
    const selection = { providerId: "anthropic", modelId: "claude-example" };

    await store.setSelection(selection);

    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toEqual(selection);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      selection,
    });
  });

  it("normalizes unsupported and malformed settings", async () => {
    const { filePath } = await createStore();
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, selection: { providerId: "x", modelId: "y" } }));
    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toBeNull();

    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, selection: { providerId: "", modelId: "y" } }));
    await expect(new AiSettingsStore(filePath).getSelection()).resolves.toBeNull();
  });
});
