import { readFile } from "node:fs/promises";

import { writeFileAtomically } from "../backend/atomic-file.js";
import { parseServerUpdateRecord, type ServerUpdateRecord, UNFINISHED_UPDATE_STATES } from "../shared/server-update.js";

/**
 * Reads the last setup's record. One left unfinished by a process that no
 * longer runs reads as interrupted: nothing will finish it.
 */
export async function readUpdateRecord(
  file: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<ServerUpdateRecord | undefined> {
  let record: ServerUpdateRecord | undefined;
  try {
    record = parseServerUpdateRecord(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
  if (record && UNFINISHED_UPDATE_STATES.has(record.state) && !isProcessAlive(record.pid)) {
    return { ...record, state: "interrupted", error: record.error ?? "The setup stopped before it finished." };
  }
  return record;
}

/** Replaces the record in one step, readable by the account only. */
export function writeUpdateRecord(file: string, record: ServerUpdateRecord): Promise<void> {
  return writeFileAtomically(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Whether a process runs; one that belongs to another account still counts. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
