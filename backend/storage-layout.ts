import { readdir, rename, rmdir, stat } from "node:fs/promises";
import path from "node:path";

/** Where a Wisp's own files live: skills, saved memory, context settings (ADR 010, ADR 027). */
export const WISP_CONFIG_DIRECTORY = "wisp-config";
/** Where a Wisp keeps its agent history in one conversation (ADR 010, ADR 027). */
export const WISP_SESSIONS_DIRECTORY = "wisp-sessions";

/** The folders' names before they stopped naming a runtime: the first of each pair is the old one. */
const RENAMED: ReadonlyArray<readonly [string, string]> = [
  ["pi-config", WISP_CONFIG_DIRECTORY],
  ["pi-sessions", WISP_SESSIONS_DIRECTORY],
];

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/**
 * Gives the data directory's Wisp folders their runtime-neutral names (ADR 027).
 * Each move is one `rename` inside the directory, so it is atomic and costs
 * nothing however large the sessions are, and a run that is interrupted
 * between the two moves finishes on the next start.
 *
 * Both names present is not merged: the old folder is dropped only when it is
 * empty, and otherwise startup stops, since either could hold a Wisp's data.
 */
export async function migrateStorageFolders(dataDirectory: string): Promise<void> {
  for (const [from, to] of RENAMED) {
    const source = path.join(dataDirectory, from);
    const target = path.join(dataDirectory, to);
    if (!(await exists(source))) continue;
    if (!(await exists(target))) {
      await rename(source, target);
    } else if ((await readdir(source)).length === 0) {
      await rmdir(source);
    } else {
      throw new Error(
        `Both ${from} and ${to} hold data in ${dataDirectory}. Move what is in ${from} into ${to} (or the other way round), then start Wisp again.`,
      );
    }
  }
}

/**
 * A job run's session file under the old session folder name, as the same path
 * under the new one. Anything else comes back unchanged.
 */
export function renamedSessionFile(file: string): string {
  return file.replace(/([\\/])pi-sessions([\\/][^\\/]+[\\/]jobs[\\/])/u, `$1${WISP_SESSIONS_DIRECTORY}$2`);
}
