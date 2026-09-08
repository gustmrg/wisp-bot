import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { ConversationRepository } from "../backend/conversation-repository.js";
import { ServerDatabase } from "../server/storage/database.js";
import { SqliteConversationRepository } from "../server/storage/conversation-repository.js";
import {
  createLocalMigration,
  exportServerBackup,
  exportServerMigration,
  importMigration,
  readTransferKey,
  restoreBackup,
  recoverInterruptedImport,
} from "../server/transfer/archive.js";
import type { Chat } from "../shared/conversations.js";

const temporary: string[] = [];
const databases: ServerDatabase[] = [];
const key = randomBytes(32);
function directory(): string {
  const value = mkdtempSync(path.join(tmpdir(), "wisp-transfer-test-"));
  temporary.push(value);
  return value;
}
function database(dir = directory()): ServerDatabase {
  const value = new ServerDatabase(dir);
  databases.push(value);
  return value;
}
function chat(): Chat {
  return {
    id: "first",
    kind: "wisp",
    shape: "circle",
    name: "First",
    label: "Test",
    description: "Test",
    preview: "Ready",
    timestamp: "Now",
    notifyOnUpdatesEnabled: true,
    messages: [{ id: "message-1", type: "incoming", text: "The original history", status: "complete" }],
  };
}
async function localFixture(): Promise<{ dir: string; sessionId: string; sessionFile: string }> {
  const dir = directory();
  const store = new ConversationRepository({ dataDirectory: dir });
  await store.initialize({ first: chat() });
  const context = store.getAgentContext("first");
  const sessionFile = path.join(context.sessionDirectory, "session.jsonl");
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: new Date().toISOString(), cwd: context.workspaceDirectory })}\n${JSON.stringify({ type: "message", id: "pi-message", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `Keep this literal path: ${context.workspaceDirectory}` } })}\n`,
  );
  await store.savePiSessionIdentity("first", { sessionId: "pi-1", sessionFile });
  writeFileSync(path.join(context.workspaceDirectory, "note.txt"), "workspace content");
  writeFileSync(
    path.join(context.configDirectory, "context-settings.json"),
    JSON.stringify({ memory: "Remember this", policy: { mode: "manual" } }),
  );
  writeFileSync(path.join(dir, "credentials.enc.json"), "source-encrypted-provider-key");
  return { dir, sessionId: context.sessionId, sessionFile };
}

function rewriteAuthenticatedArchive(file: string, modify: (bundle: any) => void): void {
  const magic = Buffer.from("WISP-ARCHIVE-1\n");
  const original = readFileSync(file);
  const decipher = createDecipheriv("aes-256-gcm", key, original.subarray(magic.length, magic.length + 12));
  decipher.setAAD(magic);
  decipher.setAuthTag(original.subarray(magic.length + 12, magic.length + 28));
  const bundle = JSON.parse(
    gunzipSync(Buffer.concat([decipher.update(original.subarray(magic.length + 28)), decipher.final()])).toString(),
  );
  modify(bundle);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(magic);
  const bytes = Buffer.concat([cipher.update(gzipSync(JSON.stringify(bundle))), cipher.final()]);
  writeFileSync(file, Buffer.concat([magic, nonce, cipher.getAuthTag(), bytes]));
}

function alterBackupDatabase(bundle: any, mutation: (sql: DatabaseSync) => void): void {
  const entry = bundle.files.find((item: any) => item.path === "wisp.sqlite");
  const file = path.join(directory(), "mutated.sqlite");
  writeFileSync(file, Buffer.from(entry.content, "base64"));
  const sql = new DatabaseSync(file);
  try {
    mutation(sql);
    sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    sql.close();
  }
  const content = readFileSync(file);
  Object.assign(entry, {
    content: content.toString("base64"),
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("encrypted remote transfer", { timeout: 30000 }, () => {
  it("migrates a history beyond the desktop blob limit without dropping messages", async () => {
    const source = database();
    await new SqliteConversationRepository(source, "Owner").create({ ...chat(), messages: [] });
    source.transaction(() => {
      const insert = source.sql.prepare("INSERT INTO messages(conversation_id,id,message) VALUES ('first',?,?)");
      for (let index = 0; index < 10001; index++)
        insert.run(
          `large-${index}`,
          JSON.stringify({ id: `large-${index}`, type: "incoming", text: String(index), status: "complete" }),
        );
    });
    const file = path.join(directory(), "large.wisp");
    expect(exportServerMigration(source, file, key).messages).toBe(10001);
    const target = database();
    importMigration(target, new SqliteConversationRepository(target, "Owner"), file, key);
    expect(target.sql.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(10001);
    expect(target.sql.prepare("SELECT message FROM messages WHERE id='large-10000'").get()?.message).toContain(
      '"text":"10000"',
    );
  });

  it("preserves migration timezone and rejects an incompatible destination before writing", async () => {
    const source = database();
    await new SqliteConversationRepository(source, "Owner").create(chat());
    source.setMeta("timeZone", "America/Fortaleza");
    const file = path.join(directory(), "timezone.wisp");
    exportServerMigration(source, file, key);
    const target = database();
    target.setMeta("timeZone", "UTC");
    expect(() =>
      importMigration(target, new SqliteConversationRepository(target, "Owner"), file, key, { dryRun: true }),
    ).toThrow("--time-zone America/Fortaleza");
    expect(target.sql.prepare("SELECT COUNT(*) AS count FROM conversations").get()?.count).toBe(0);
    expect(existsSync(path.join(target.directory, ".import-journal.json"))).toBe(false);
    const empty = database();
    importMigration(empty, new SqliteConversationRepository(empty, "Owner"), file, key);
    expect(empty.getMeta("timeZone")).toBe("America/Fortaleza");
    const local = await localFixture();
    const localFile = path.join(directory(), "local-timezone.wisp");
    createLocalMigration(local.dir, localFile, key, { timeZone: "Europe/Paris" });
    const localTarget = database();
    importMigration(localTarget, new SqliteConversationRepository(localTarget, "Owner"), localFile, key);
    expect(localTarget.getMeta("timeZone")).toBe("Europe/Paris");
  });

  it("rejects backup database identities, metadata, and messages that disagree with its manifest", async () => {
    const source = database();
    await new SqliteConversationRepository(source, "Owner").create(chat());
    for (const alteration of ["extra", "session-path", "message"]) {
      const file = path.join(directory(), `${alteration}.wisp`);
      exportServerBackup(source, file, key);
      rewriteAuthenticatedArchive(file, (bundle) =>
        alterBackupDatabase(bundle, (sql) => {
          if (alteration === "extra")
            sql
              .prepare("INSERT INTO conversations(id,record,revision) VALUES ('hidden',?,1)")
              .run(
                JSON.stringify({ ...source.sql.prepare("SELECT record FROM conversations WHERE id='first'").get() }),
              );
          else if (alteration === "session-path") {
            const record = JSON.parse(
              sql.prepare("SELECT record FROM conversations WHERE id='first'").get()!.record as string,
            );
            record.sessionId = "../../outside";
            sql.prepare("UPDATE conversations SET record=? WHERE id='first'").run(JSON.stringify(record));
          } else
            sql
              .prepare("UPDATE messages SET message=? WHERE id='message-1'")
              .run(JSON.stringify({ id: "message-1", type: "incoming", text: "Replaced", status: "complete" }));
        }),
      );
      const target = path.join(directory(), "restored");
      expect(() => restoreBackup(file, target, key)).toThrow();
      expect(existsSync(target)).toBe(false);
      const dryTarget = path.join(directory(), "uncreated-parent", "restored");
      expect(() => restoreBackup(file, dryTarget, key, { dryRun: true })).toThrow();
      expect(existsSync(path.dirname(dryTarget))).toBe(false);
    }
  });

  it("recovers an interrupted import without touching paths outside its fixed roots", async () => {
    const target = database();
    const archiveId = "00000000-0000-4000-8000-000000000000";
    mkdirSync(path.join(target.directory, ".import-abc123"));
    mkdirSync(path.join(target.directory, "workspaces"));
    writeFileSync(path.join(target.directory, "workspaces", "partial.txt"), "partial transfer");
    writeFileSync(
      path.join(target.directory, ".import-journal.json"),
      JSON.stringify({ archiveId, staging: ".import-abc123", roots: ["workspaces"] }),
      { mode: 0o600 },
    );
    const root = target.directory;
    target.close();
    databases.splice(databases.indexOf(target), 1);
    const reopened = database(root);
    recoverInterruptedImport(reopened);
    expect(existsSync(path.join(root, "workspaces"))).toBe(false);
    expect(existsSync(path.join(root, ".import-abc123"))).toBe(false);
    expect(existsSync(path.join(root, ".import-journal.json"))).toBe(false);
    writeFileSync(
      path.join(root, ".import-journal.json"),
      JSON.stringify({ archiveId, staging: "../outside", roots: ["workspaces"] }),
    );
    expect(() => recoverInterruptedImport(reopened)).toThrow("invalid paths");
  });

  it("cleans a committed import journal while preserving its installed files", async () => {
    const target = database();
    const archiveId = "00000000-0000-4000-8000-000000000000";
    await new SqliteConversationRepository(target, "Owner").create(chat());
    target.setMeta(`import:${archiveId}`, new Date().toISOString());
    mkdirSync(path.join(target.directory, ".import-abc123"));
    writeFileSync(path.join(target.directory, "workspaces", "keep.txt"), "committed");
    writeFileSync(
      path.join(target.directory, ".import-journal.json"),
      JSON.stringify({ archiveId, staging: ".import-abc123", roots: ["workspaces"] }),
    );
    recoverInterruptedImport(target);
    expect(readFileSync(path.join(target.directory, "workspaces", "keep.txt"), "utf8")).toBe("committed");
    expect(existsSync(path.join(target.directory, ".import-journal.json"))).toBe(false);
  });
  it("exports all pages of server history and preserves authoritative settings", async () => {
    const source = database();
    const repository = new SqliteConversationRepository(source, "Owner");
    await repository.create(chat());
    for (let index = 0; index < 240; index++)
      await repository.appendMessage("first", {
        id: `history-${index}`,
        type: "incoming",
        text: `Record ${index}`,
        status: "complete",
      });
    source.setMeta("modelSelection", JSON.stringify({ providerId: "provider", modelId: "model" }));
    source.setMeta("toolPolicy", JSON.stringify({ autoReview: false, rules: [] }));
    expect(repository.messages("first").messages).toHaveLength(200);
    const file = path.join(directory(), "server.wisp");
    expect(exportServerMigration(source, file, key).messages).toBe(241);
    const target = database();
    const targetRepository = new SqliteConversationRepository(target, "Owner");
    importMigration(target, targetRepository, file, key);
    expect(Number(target.sql.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count)).toBe(241);
    expect(target.getMeta("modelSelection")).toBe(source.getMeta("modelSelection"));
    expect(target.getMeta("toolPolicy")).toBe(source.getMeta("toolPolicy"));
  });
  it("imports stable identities, complete history and workspaces while remapping only Pi metadata", async () => {
    const source = await localFixture();
    const original = readFileSync(path.join(source.dir, "conversations.json"));
    const archive = path.join(directory(), "migration.wisp");
    const summary = createLocalMigration(source.dir, archive, key);
    expect(summary).toMatchObject({ conversations: 1, messages: 1, dryRun: false });
    expect(readFileSync(archive).includes(Buffer.from("The original history"))).toBe(false);
    const target = database();
    const repository = new SqliteConversationRepository(target, "Owner");
    expect(importMigration(target, repository, archive, key, { dryRun: true }).dryRun).toBe(true);
    expect(repository.list()).toHaveLength(0);
    importMigration(target, repository, archive, key);
    expect(repository.getChats().first?.messages).toEqual(chat().messages);
    const context = repository.getAgentContext("first");
    expect(context.sessionId).toBe(source.sessionId);
    expect(context.piSessionFile).toBe(path.join(context.sessionDirectory, "session.jsonl"));
    const entries = readFileSync(context.piSessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[0].cwd).toBe(context.workspaceDirectory);
    expect(entries[1].message.content).toContain(path.join(source.dir, "workspaces", source.sessionId));
    expect(readFileSync(path.join(context.workspaceDirectory, "note.txt"), "utf8")).toBe("workspace content");
    expect(existsSync(path.join(target.directory, "credentials.enc.json"))).toBe(false);
    expect(readFileSync(path.join(source.dir, "conversations.json"))).toEqual(original);
    expect(() => importMigration(target, repository, archive, key)).toThrow("already been imported");
  });

  it("restores a full backup into a new path, invalidates cursors and revokes historical devices", async () => {
    const source = await localFixture();
    const transfer = path.join(directory(), "migration.wisp");
    createLocalMigration(source.dir, transfer, key);
    const live = database();
    const repository = new SqliteConversationRepository(live, "Owner");
    importMigration(live, repository, transfer, key);
    writeFileSync(path.join(live.directory, "credentials.enc.json"), "encrypted-not-plaintext");
    live.sql
      .prepare("INSERT INTO devices(id,name,created_at) VALUES (?,?,?)")
      .run("device-1", "Desktop", new Date().toISOString());
    const oldCursor = live.cursor();
    const backup = path.join(directory(), "backup.wisp");
    exportServerBackup(live, backup, key);
    const restoredDirectory = path.join(directory(), "restored");
    const dryTarget = path.join(directory(), "uncreated-parent", "restored");
    expect(restoreBackup(backup, dryTarget, key, { dryRun: true }).dryRun).toBe(true);
    expect(existsSync(path.dirname(dryTarget))).toBe(false);
    restoreBackup(backup, restoredDirectory, key);
    const restored = database(restoredDirectory);
    const restoredRepo = new SqliteConversationRepository(restored, "Owner");
    expect(restoredRepo.getChats().first?.messages).toEqual(chat().messages);
    expect(restoredRepo.getAgentContext("first").piSessionFile).toContain(restoredDirectory);
    expect(restored.sql.prepare("SELECT revoked FROM devices WHERE id='device-1'").get()?.revoked).toBe(1);
    expect(() => restored.eventsAfter(oldCursor)).toThrow();
    expect(readFileSync(path.join(restoredDirectory, "credentials.enc.json"), "utf8")).toBe("encrypted-not-plaintext");
    expect(() => restoreBackup(backup, live.directory, key)).toThrow("new destination");
  });

  it("rejects wrong keys and tampering before writing any destination data", async () => {
    const source = await localFixture();
    const archive = path.join(directory(), "migration.wisp");
    createLocalMigration(source.dir, archive, key);
    const target = database();
    const repository = new SqliteConversationRepository(target, "Owner");
    expect(() => importMigration(target, repository, archive, randomBytes(32))).toThrow("key is incorrect");
    const damaged = readFileSync(archive);
    damaged[damaged.length - 1] ^= 1;
    writeFileSync(archive, damaged);
    expect(() => importMigration(target, repository, archive, key)).toThrow("damaged");
    expect(repository.list()).toHaveLength(0);
  });

  it("rejects symlinks in local workspaces and refuses to overwrite archive files", async () => {
    const source = await localFixture();
    const archive = path.join(directory(), "migration.wisp");
    createLocalMigration(source.dir, archive, key);
    expect(() => createLocalMigration(source.dir, archive, key)).toThrow();
    symlinkSync(
      path.join(source.dir, "credentials.enc.json"),
      path.join(source.dir, "workspaces", source.sessionId, "secret-link"),
    );
    expect(() => createLocalMigration(source.dir, path.join(directory(), "other.wisp"), key)).toThrow("Symbolic links");
  });

  it("rejects authenticated archives with traversal paths", () => {
    const magic = Buffer.from("WISP-ARCHIVE-1\n");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(magic);
    const malformed = {
      format: "wisp-transfer",
      version: 1,
      kind: "migration",
      id: "00000000-0000-4000-8000-000000000000",
      createdAt: new Date().toISOString(),
      records: [],
      files: [{ path: "workspaces/../../escaped", content: "", size: 0, sha256: "ignored" }],
    };
    const payload = Buffer.concat([cipher.update(gzipSync(JSON.stringify(malformed))), cipher.final()]);
    const archive = path.join(directory(), "malicious.wisp");
    writeFileSync(archive, Buffer.concat([magic, nonce, cipher.getAuthTag(), payload]));
    const target = database();
    expect(() => importMigration(target, new SqliteConversationRepository(target, "Owner"), archive, key)).toThrow(
      "inside the destination",
    );
    expect(existsSync(path.join(path.dirname(target.directory), "escaped"))).toBe(false);
  });

  it("enforces private key permissions and bounded inputs", () => {
    const file = path.join(directory(), "archive.key");
    writeFileSync(file, key, { mode: 0o600 });
    expect(readTransferKey(file)).toEqual(key);
    const wrong = path.join(directory(), "wrong.key");
    writeFileSync(wrong, randomBytes(64), { mode: 0o600 });
    expect(() => readTransferKey(wrong)).toThrow("bounded");
    const link = path.join(directory(), "key-link");
    symlinkSync(file, link);
    expect(() => readTransferKey(link)).toThrow("private regular file");
  });

  it("refuses nonempty imports and active-work backups", async () => {
    const source = await localFixture();
    const archive = path.join(directory(), "migration.wisp");
    createLocalMigration(source.dir, archive, key);
    const target = database();
    const repository = new SqliteConversationRepository(target, "Owner");
    await repository.create(chat());
    expect(() => importMigration(target, repository, archive, key)).toThrow("empty destination");
    target.sql
      .prepare(
        "INSERT INTO requests(conversation_id,id,payload_hash,payload,status,revision,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run("first", "request-1", "hash", "{}", "running", 1, new Date().toISOString());
    expect(() => exportServerBackup(target, path.join(directory(), "backup.wisp"), key)).toThrow("all work");
  });
});
