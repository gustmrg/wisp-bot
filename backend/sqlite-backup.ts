import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Thrown when a database could not be opened but its file is intact: it was
 * written by a newer app version, or it could not be backed up before an
 * upgrade. The file must stay where it is, never be set aside as corrupt.
 */
export class IntactDatabaseError extends Error {}

/** Backups kept beside a database: enough to step back over a few upgrades. */
const KEPT_BACKUPS = 3;

/**
 * Copies the database at `filePath`, as `version` left it, before this build
 * upgrades it, so going back to a build that reads `version` stays possible.
 * It is named after `version`, and only the newest few are kept: an older
 * build can restore one at or below the version it reads.
 */
export function backUpBeforeUpgrade(db: DatabaseSync, filePath: string, version: number): void {
  const backup = `${filePath}.v${version}.backup`;
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.v`;
  try {
    rmSync(backup, { force: true });
    // Unlike a file copy, this includes commits still in the write-ahead log.
    db.prepare("VACUUM INTO ?").run(backup);
  } catch (error) {
    throw new IntactDatabaseError(
      `Could not back up ${path.basename(filePath)} before upgrading it: ${(error as Error).message}`,
      { cause: error },
    );
  }
  const backups = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && /^\d+\.backup$/.test(name.slice(prefix.length)))
    .sort((left, right) => Number.parseInt(right.slice(prefix.length)) - Number.parseInt(left.slice(prefix.length)));
  for (const name of backups.slice(KEPT_BACKUPS)) rmSync(path.join(directory, name), { force: true });
}
