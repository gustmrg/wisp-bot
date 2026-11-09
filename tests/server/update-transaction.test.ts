import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationService } from "../../backend/conversation-service.js";
import { ExecutionService } from "../../backend/execution-service.js";
import { JobScheduler } from "../../backend/job-scheduler.js";
import { MessageQueue } from "../../backend/message-queue.js";
import { MessageScheduler } from "../../backend/message-scheduler.js";
import { StructuredLogger } from "../../backend/structured-logger.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import {
  coveredFiles,
  prepareServerData,
  readJournal,
  recoverTransaction,
  restoreSnapshot,
  takeSnapshot,
  TRANSACTION_JOURNAL,
} from "../../server/update-transaction.js";
import { createWispServer } from "../../server/wisp-server.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const journal = { id: "0b7f8a6e-2c1d-4e5f-9a8b-7c6d5e4f3a2b", fromVersion: "1.2.0", targetVersion: "1.3.0" };

/** A data directory a server has used, with what the rollback covers and what it does not. */
async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-transaction-"));
  directories.push(directory);
  await mkdir(path.join(directory, "backend/workspaces/atlas"), { recursive: true });
  await writeFile(path.join(directory, "server.sqlite"), "server v1");
  await writeFile(path.join(directory, "backend/conversations.sqlite"), "conversations v1");
  await writeFile(path.join(directory, "backend/conversations.sqlite-wal"), "wal v1");
  await writeFile(path.join(directory, "backend/ai-settings.json"), '{"v":1}');
  await writeFile(path.join(directory, "backend/workspaces/atlas/notes.md"), "notes v1");
  return directory;
}

/** What a new version does to the data while it starts: upgrades, adds, and drops files. */
async function upgrade(directory: string): Promise<void> {
  await writeFile(path.join(directory, "server.sqlite"), "server v2");
  await writeFile(path.join(directory, "backend/conversations.sqlite"), "conversations v2");
  await rm(path.join(directory, "backend/conversations.sqlite-wal"));
  await writeFile(path.join(directory, "backend/conversations.sqlite-shm"), "shm v2");
  await writeFile(path.join(directory, "backend/ai-settings.json"), '{"v":2}');
  await writeFile(path.join(directory, "backend/new-settings.json"), "{}");
  await writeFile(path.join(directory, "backend/workspaces/atlas/notes.md"), "notes v2");
}

async function expectOriginal(directory: string): Promise<void> {
  const read = (file: string) => readFile(path.join(directory, file), "utf8");
  expect(await read("server.sqlite")).toBe("server v1");
  expect(await read("backend/conversations.sqlite")).toBe("conversations v1");
  expect(await read("backend/conversations.sqlite-wal")).toBe("wal v1");
  expect(await read("backend/ai-settings.json")).toBe('{"v":1}');
  expect(await coveredFiles(directory)).toEqual([
    "backend/ai-settings.json",
    "backend/conversations.sqlite",
    "backend/conversations.sqlite-wal",
    "server.sqlite",
  ]);
  expect(await readJournal(directory)).toBeUndefined();
  expect((await readdir(directory)).sort()).toEqual(["backend", "server.sqlite"]);
}

describe("server update transactions", () => {
  it("rolls the covered files back, removing what the new version added, and leaves workspaces alone", async () => {
    const directory = await dataDirectory();
    await takeSnapshot(directory, { ...journal, step: "snapshotting" });
    expect(await readJournal(directory)).toMatchObject({ step: "trying" });
    await upgrade(directory);

    await restoreSnapshot(directory, { ...journal, step: "trying" });
    await expectOriginal(directory);
    expect(await readFile(path.join(directory, "backend/workspaces/atlas/notes.md"), "utf8")).toBe("notes v2");
  });

  it("rolls back a transaction stopped while trying or restoring, and drops one stopped while snapshotting", async () => {
    for (const step of ["trying", "restoring"] as const) {
      const directory = await dataDirectory();
      await takeSnapshot(directory, { ...journal, step: "snapshotting" });
      await upgrade(directory);
      await writeFile(path.join(directory, TRANSACTION_JOURNAL), JSON.stringify({ ...journal, step }));
      expect(await recoverTransaction(directory)).toMatchObject({ outcome: "rolled-back" });
      await expectOriginal(directory);
    }

    const directory = await dataDirectory();
    await writeFile(path.join(directory, TRANSACTION_JOURNAL), JSON.stringify({ ...journal, step: "snapshotting" }));
    await mkdir(path.join(directory, `update-snapshots/${journal.id}.staging`), { recursive: true });
    expect(await recoverTransaction(directory)).toMatchObject({ outcome: "discarded" });
    await expectOriginal(directory);
    expect(await recoverTransaction(directory)).toBeUndefined();
  });

  it("is finished by the next server that opens the data directory, before it reads anything", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-transaction-server-"));
    directories.push(directory);
    const key = randomBytes(32);
    const options = {
      dataDirectory: directory,
      host: "127.0.0.1",
      port: 0,
      encryption: new MasterKeyEncryption(key),
      logger: silent,
      agentMode: "fake" as const,
      appVersion: "1.2.0",
      allowModelNetwork: false,
    };
    const first = await createWispServer(options);
    const serverId = first.serverId;
    await first.close();

    await takeSnapshot(directory, { ...journal, step: "snapshotting" });
    // A new version that replaced the server's identity, then died.
    await rm(path.join(directory, "server.sqlite"));
    const restarted = await createWispServer(options);
    try {
      expect(restarted.serverId).toBe(serverId);
      expect(await readJournal(directory)).toBeUndefined();
    } finally {
      await restarted.close();
    }
  });

  it("prepares the data with the new version without activating anything", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-transaction-prepare-"));
    directories.push(directory);
    const encryption = new MasterKeyEncryption(randomBytes(32));
    const started = [
      vi.spyOn(ConversationService.prototype, "start"),
      vi.spyOn(MessageQueue.prototype, "start"),
      vi.spyOn(MessageScheduler.prototype, "start"),
      vi.spyOn(JobScheduler.prototype, "start"),
      vi.spyOn(ExecutionService.prototype, "reconcile"),
    ];
    await prepareServerData({ dataDirectory: directory, encryption, logger: silent, appVersion: "1.3.0" });
    expect(await coveredFiles(directory)).toEqual(
      expect.arrayContaining(["server.sqlite", "backend/conversations.sqlite"]),
    );
    for (const spy of started) expect(spy).not.toHaveBeenCalled();

    // The same composition activates all of them when a server starts.
    const server = await createWispServer({
      dataDirectory: directory,
      host: "127.0.0.1",
      port: 0,
      encryption,
      logger: silent,
      agentMode: "fake",
      appVersion: "1.3.0",
      allowModelNetwork: false,
    });
    await server.close();
    for (const spy of started) expect(spy).toHaveBeenCalled();
  });

  it("fails to prepare a database the new version cannot read, which a start would set aside", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-transaction-corrupt-"));
    directories.push(directory);
    await mkdir(path.join(directory, "backend"));
    await writeFile(path.join(directory, "backend/conversations.sqlite"), "not a database");
    await expect(
      prepareServerData({
        dataDirectory: directory,
        encryption: new MasterKeyEncryption(randomBytes(32)),
        logger: silent,
        appVersion: "1.3.0",
      }),
    ).rejects.toThrow("The conversation database could not be read and was set aside.");
  });
});
