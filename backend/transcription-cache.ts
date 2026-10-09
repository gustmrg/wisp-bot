import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "./atomic-file.js";

/** Kept in each Wisp's configuration directory, out of its workspace and of backups. */
export const TRANSCRIPTION_CACHE_DIRECTORY = "transcription-cache";
const MAX_IDLE_MS = 30 * 86_400_000;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;

export interface TranscriptionKey {
  /** SHA-256 of the file's bytes. */
  contentHash: string;
  providerId: string;
  modelId: string;
  /** PDF page number; absent for image files. */
  page?: number;
  /** Version of the transcription prompt, so a changed prompt misses the cache. */
  promptVersion: number;
}

export function hashContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Transcriptions of images and scanned pages, so reading a file again does not
 * call the provider again. A changed file, model, or prompt makes a new key;
 * old entries age out. Each write removes entries unused for 30 days, then the
 * oldest until the cache is under 20 MB. A read refreshes an entry's age.
 */
export class TranscriptionCache {
  private readonly directory: string;
  private readonly now: () => number;

  constructor(directory: string, now: () => number = Date.now) {
    this.directory = directory;
    this.now = now;
  }

  async get(key: TranscriptionKey): Promise<string | null> {
    const file = this.fileFor(key);
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as { text?: unknown };
      if (typeof entry.text !== "string") return null;
      const time = new Date(this.now());
      await utimes(file, time, time).catch(() => undefined);
      return entry.text;
    } catch {
      return null;
    }
  }

  async set(key: TranscriptionKey, text: string): Promise<void> {
    const file = this.fileFor(key);
    await writeFileAtomically(file, JSON.stringify({ text }));
    const time = new Date(this.now());
    await utimes(file, time, time).catch(() => undefined);
    await this.evict();
  }

  private fileFor(key: TranscriptionKey): string {
    const name = createHash("sha256")
      .update(JSON.stringify([key.promptVersion, key.providerId, key.modelId, key.contentHash, key.page ?? null]))
      .digest("hex");
    return path.join(this.directory, `${name}.json`);
  }

  private async evict(): Promise<void> {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
    const entries = (
      await Promise.all(
        names.map(async (name) => {
          const file = path.join(this.directory, name);
          const info = await stat(file).catch(() => null);
          return info ? { file, size: info.size, usedAt: info.mtimeMs } : null;
        }),
      )
    )
      .filter((entry): entry is { file: string; size: number; usedAt: number } => entry !== null)
      .sort((left, right) => left.usedAt - right.usedAt);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const cutoff = this.now() - MAX_IDLE_MS;
    for (const entry of entries) {
      if (entry.usedAt >= cutoff && total <= MAX_CACHE_BYTES) break;
      await rm(entry.file, { force: true });
      total -= entry.size;
    }
  }
}
