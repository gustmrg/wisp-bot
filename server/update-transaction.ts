import { constants } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import { prepareBackendData } from "../backend/runtime.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import { ServerStore } from "./server-store.js";

/**
 * A server update as a transaction over the data directory (ADR 046). Once
 * the old server has stopped, the update snapshots the files a new version
 * may change while it starts, opens the data with the new version without
 * activating anything (`prepareServerData`), and commits only if that works.
 * Otherwise, or when anything stops it halfway, the snapshot is restored.
 *
 * The journal, `.update-transaction.json` in the data directory, says where
 * the transaction is. Whoever opens the data directory next, holding its
 * lock, finishes what it says: the setup that runs again, or the server,
 * whichever version `current` points to.
 */
export const TRANSACTION_JOURNAL = ".update-transaction.json";
const SNAPSHOTS = "update-snapshots";
const MANIFEST = "files.json";

/**
 * snapshotting: the snapshot is being written; the data is untouched.
 * trying: the new version opens the data; restore the snapshot unless committed.
 * restoring: the snapshot is being put back; do it again until done.
 */
export interface TransactionJournal {
  id: string;
  step: "snapshotting" | "trying" | "restoring";
  fromVersion?: string;
  targetVersion: string;
}

/**
 * What the rollback covers: the server's and the backend's databases with
 * their journals, and the settings and credential files beside the backend
 * database. Workspaces, agent sessions, logs and containers are not covered;
 * starting a new version does not change them.
 */
export async function coveredFiles(dataDirectory: string): Promise<string[]> {
  const files: string[] = [];
  for (const database of ["server.sqlite", "backend/conversations.sqlite"]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (await isFile(path.join(dataDirectory, `${database}${suffix}`))) files.push(`${database}${suffix}`);
    }
  }
  const backend = await readdir(path.join(dataDirectory, "backend"), { withFileTypes: true }).catch(() => []);
  for (const entry of backend) {
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(`backend/${entry.name}`);
  }
  return files.sort();
}

/** Free space a snapshot needs: the covered files, with room to spare. */
export async function snapshotSpace(dataDirectory: string): Promise<number> {
  let size = 0;
  for (const file of await coveredFiles(dataDirectory)) size += (await stat(path.join(dataDirectory, file))).size;
  return Math.ceil(size * 1.1) + 16 * 1024 * 1024;
}

/** Free space on the file system that holds `directory`. */
export async function freeSpace(directory: string): Promise<number> {
  const { bavail, bsize } = await statfs(directory);
  return bavail * bsize;
}

export async function readJournal(dataDirectory: string): Promise<TransactionJournal | undefined> {
  try {
    const value = JSON.parse(
      await readFile(path.join(dataDirectory, TRANSACTION_JOURNAL), "utf8"),
    ) as TransactionJournal;
    return typeof value.id === "string" && /^[\w-]{1,64}$/.test(value.id) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeJournal(dataDirectory: string, journal: TransactionJournal): Promise<void> {
  await writeDurably(path.join(dataDirectory, TRANSACTION_JOURNAL), `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * Copies the covered files into `update-snapshots/<id>`, through a staging
 * folder renamed into place once every file is on disk. The old server must
 * have stopped and the caller must hold the data directory's lock.
 */
export async function takeSnapshot(dataDirectory: string, journal: TransactionJournal): Promise<void> {
  await writeJournal(dataDirectory, { ...journal, step: "snapshotting" });
  const final = snapshotDirectory(dataDirectory, journal.id);
  const staging = `${final}.staging`;
  await rm(staging, { recursive: true, force: true });
  const files = await coveredFiles(dataDirectory);
  for (const file of files) {
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(dataDirectory, file), target, constants.COPYFILE_FICLONE);
    await syncFile(target);
  }
  await writeDurably(path.join(staging, MANIFEST), `${JSON.stringify(files)}\n`);
  await rm(final, { recursive: true, force: true });
  await rename(staging, final);
  await syncDirectory(path.dirname(final));
  await writeJournal(dataDirectory, { ...journal, step: "trying" });
}

/**
 * Puts the snapshot back: every file it holds over the live one, and covered
 * files it does not hold (a database journal or a settings file the new
 * version created) removed. Safe to run again after an interruption.
 */
export async function restoreSnapshot(dataDirectory: string, journal: TransactionJournal): Promise<void> {
  await writeJournal(dataDirectory, { ...journal, step: "restoring" });
  const snapshot = snapshotDirectory(dataDirectory, journal.id);
  const saved = JSON.parse(await readFile(path.join(snapshot, MANIFEST), "utf8")) as string[];
  for (const file of await coveredFiles(dataDirectory)) {
    if (!saved.includes(file)) await rm(path.join(dataDirectory, file), { force: true });
  }
  for (const file of saved) {
    const target = path.join(dataDirectory, file);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.restoring`;
    await copyFile(path.join(snapshot, file), temporary);
    await syncFile(temporary);
    await rename(temporary, target);
  }
  await syncDirectory(dataDirectory);
  await syncDirectory(path.join(dataDirectory, "backend")).catch(() => undefined);
  await finish(dataDirectory);
}

/** Ends a transaction that succeeded: the journal goes first, then the snapshot. */
export async function commitTransaction(dataDirectory: string): Promise<void> {
  await finish(dataDirectory);
}

async function finish(dataDirectory: string): Promise<void> {
  await rm(path.join(dataDirectory, TRANSACTION_JOURNAL), { force: true });
  await syncDirectory(dataDirectory);
  await rm(path.join(dataDirectory, SNAPSHOTS), { recursive: true, force: true });
}

/**
 * Finishes a transaction an interrupted update left, before anything opens
 * the data: one stopped while snapshotting changed nothing and is dropped;
 * one stopped while trying or restoring is rolled back. The caller holds the
 * data directory's lock. Resolves with what it did, if anything.
 */
export async function recoverTransaction(
  dataDirectory: string,
): Promise<{ journal: TransactionJournal; outcome: "discarded" | "rolled-back" } | undefined> {
  const journal = await readJournal(dataDirectory);
  if (!journal) {
    // A snapshot left after its journal was removed belongs to no transaction.
    await rm(path.join(dataDirectory, SNAPSHOTS), { recursive: true, force: true });
    return undefined;
  }
  if (journal.step === "snapshotting") {
    await finish(dataDirectory);
    return { journal, outcome: "discarded" };
  }
  await restoreSnapshot(dataDirectory, journal);
  return { journal, outcome: "rolled-back" };
}

/**
 * Opens the server's data with this version, upgrading its databases and
 * loading every store, without starting anything; then closes it. This is
 * the new version's trial in an update. The caller holds the lock.
 */
export async function prepareServerData(options: {
  dataDirectory: string;
  encryption: EncryptionService;
  logger: StructuredLogger;
  appVersion: string;
}): Promise<void> {
  new ServerStore(options.dataDirectory).close();
  const unavailable = async (): Promise<never> => {
    throw new Error("Nothing runs while an update prepares the data.");
  };
  await prepareBackendData({
    dataDirectory: path.join(options.dataDirectory, "backend"),
    encryption: options.encryption,
    logger: options.logger,
    agentMode: "pi",
    appVersion: options.appVersion,
    containerPrograms: [],
    selectApprovalWindowId: () => null,
    openExternal: unavailable,
    openPath: unavailable,
    selectFiles: unavailable,
    onAgentEvent: () => undefined,
    onConversationChanged: () => undefined,
    onMcpSettingsChanged: () => undefined,
    onScheduledMessagesChanged: () => undefined,
    onMessageQueueChanged: () => undefined,
    onJobsChanged: () => undefined,
  });
}

function snapshotDirectory(dataDirectory: string, id: string): string {
  return path.join(dataDirectory, SNAPSHOTS, id);
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** Writes a file through a temporary one, synced, so a crash leaves the old or the new file whole. */
async function writeDurably(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await syncFile(temporary);
  await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r").catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}
