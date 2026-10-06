import { readFile } from "node:fs/promises";

import { writeFileAtomically } from "../../backend/atomic-file.js";

/**
 * Records the version of this launch and returns the version that ran before
 * it when the two differ, so the app can announce a completed update. The
 * first launch ever has nothing to compare against and returns undefined.
 */
export async function recordLaunchVersion(filePath: string, currentVersion: string): Promise<string | undefined> {
  const previous = await readFile(filePath, "utf8").then(
    (contents) => contents.trim() || undefined,
    () => undefined,
  );
  if (previous === currentVersion) return undefined;
  await writeFileAtomically(filePath, `${currentVersion}\n`);
  return previous;
}
