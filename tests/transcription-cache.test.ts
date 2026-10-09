import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashContent, TranscriptionCache, type TranscriptionKey } from "../backend/transcription-cache.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-transcriptions-"));
  directories.push(directory);
  return path.join(directory, "transcription-cache");
}

const key: TranscriptionKey = {
  contentHash: hashContent(Buffer.from("scan")),
  providerId: "openai",
  modelId: "vision",
  page: 2,
  promptVersion: 1,
};

describe("TranscriptionCache", () => {
  it("returns a saved transcription only for the same file, model, page, and prompt", async () => {
    const cache = new TranscriptionCache(await cacheDirectory());
    await expect(cache.get(key)).resolves.toBeNull();

    await cache.set(key, "Invoice 42");

    await expect(cache.get(key)).resolves.toBe("Invoice 42");
    await expect(cache.get({ ...key, page: 3 })).resolves.toBeNull();
    await expect(cache.get({ ...key, modelId: "other" })).resolves.toBeNull();
    await expect(cache.get({ ...key, promptVersion: 2 })).resolves.toBeNull();
    await expect(cache.get({ ...key, contentHash: hashContent(Buffer.from("changed")) })).resolves.toBeNull();
    await expect(cache.get({ ...key, page: undefined })).resolves.toBeNull();
  });

  it("removes entries unused for 30 days when it writes", async () => {
    const directory = await cacheDirectory();
    let now = Date.parse("2026-10-01T00:00:00Z");
    const cache = new TranscriptionCache(directory, () => now);
    await cache.set(key, "old");
    now += 31 * 86_400_000;

    await cache.set({ ...key, page: 3 }, "new");

    await expect(cache.get(key)).resolves.toBeNull();
    await expect(cache.get({ ...key, page: 3 })).resolves.toBe("new");
  });

  it("removes the least recently used entries above 20 MB", async () => {
    const directory = await cacheDirectory();
    const cache = new TranscriptionCache(directory);
    await cache.set(key, "keep");
    // Two large entries written earlier than the kept one; the oldest goes first.
    const large = JSON.stringify({ text: "x".repeat(11 * 1024 * 1024) });
    const older = new Date(Date.now() - 2 * 3_600_000);
    const old = new Date(Date.now() - 3_600_000);
    await writeFile(path.join(directory, "older.json"), large);
    await utimes(path.join(directory, "older.json"), older, older);
    await writeFile(path.join(directory, "old.json"), large);
    await utimes(path.join(directory, "old.json"), old, old);

    await cache.set({ ...key, page: 9 }, "newest");

    const names = await readdir(directory);
    expect(names).not.toContain("older.json");
    expect(names).toContain("old.json");
    await expect(cache.get(key)).resolves.toBe("keep");
  });
});
