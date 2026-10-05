import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Replaces a file so readers see either the old or the new contents, even
 * across a crash or power loss: the data is flushed to disk before the rename,
 * and the directory is flushed after it so the rename itself survives.
 */
export async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      // Without this, filesystems that reorder data and metadata writes can
      // leave the renamed file empty after a power loss.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

// Best effort: Windows cannot open a directory to flush it, and a failure here
// only weakens durability of an already completed write.
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Some filesystems reject directory fsync.
  } finally {
    await handle.close();
  }
}
