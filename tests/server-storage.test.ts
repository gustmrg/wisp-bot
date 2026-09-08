import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ServerDatabase } from "../server/storage/database.js";
import { SqliteConversationRepository } from "../server/storage/conversation-repository.js";
import { DeviceAuth } from "../server/auth/device-auth.js";
import { MasterKeyEncryption } from "../server/encryption/master-key.js";
import { createWispServer, type WispServer } from "../server/application.js";
import { EncryptedCredentialStore } from "../backend/encrypted-credential-store.js";

const databases: ServerDatabase[] = [],
  servers: WispServer[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function database(): Promise<ServerDatabase> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-sqlite-"));
  directories.push(directory);
  const db = new ServerDatabase(directory);
  databases.push(db);
  return db;
}
const chat = (id = "first") => ({
  id,
  kind: "wisp",
  shape: "circle",
  name: id,
  label: "Test",
  description: "",
  notifyOnUpdatesEnabled: true,
  preview: "",
  timestamp: "Now",
  messages: [],
});

describe("durable server storage", () => {
  it("rolls state and outbox back together on a persistence failure", async () => {
    const db = await database();
    const repository = new SqliteConversationRepository(db, "Owner");
    await repository.create(chat());
    const cursor = db.cursor();
    const revision = repository.revision("first");
    db.sql.exec("CREATE TRIGGER inject_disk_full BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'disk full'); END");
    await expect(
      repository.appendMessage("first", { id: "not-saved", type: "outgoing", text: "Never acknowledged" }),
    ).rejects.toThrow("disk full");
    expect(repository.messages("first").messages).toEqual([]);
    expect(repository.revision("first")).toBe(revision);
    expect(db.cursor()).toBe(cursor);
    db.sql.exec("DROP TRIGGER inject_disk_full");
    await repository.appendMessage("first", { id: "saved", type: "outgoing", text: "Saved" });
    expect(db.eventsAfter(cursor)).toHaveLength(1);
  });

  it("keeps history when event retention expires and invalidates cursors after restore", async () => {
    const db = await database();
    const repository = new SqliteConversationRepository(db, "Owner");
    await repository.create(chat());
    const cursor = db.cursor();
    await repository.appendMessage("first", { id: "message", type: "incoming", text: "Durable" });
    db.retainEvents(Date.now() + 90_000_000);
    expect(() => db.eventsAfter(cursor)).toThrow("expired");
    expect(repository.messages("first").messages[0]?.text).toBe("Durable");
    const latest = db.cursor();
    db.invalidateCursors();
    expect(() => db.eventsAfter(latest)).toThrow("Reload");
    const valid = db.cursor();
    expect(() =>
      db.transaction(() => {
        db.invalidateCursors();
        throw new Error("failed import");
      }),
    ).toThrow("failed import");
    expect(db.cursor()).toBe(valid);
  });

  it("paginates messages without losing earlier history or duplicating updated messages", async () => {
    const db = await database();
    const repository = new SqliteConversationRepository(db, "Owner");
    await repository.create(chat());
    for (let index = 0; index < 230; index++)
      await repository.appendMessage("first", { id: `message-${index}`, type: "incoming", text: String(index) });
    await repository.appendMessage("first", { id: "message-229", type: "incoming", text: "Updated" });
    const latest = repository.messages("first");
    expect(latest.messages).toHaveLength(200);
    expect(latest.messages.at(-1)?.text).toBe("Updated");
    const previous = repository.messages("first", latest.nextCursor!);
    expect(previous.messages).toHaveLength(30);
    expect(previous.nextCursor).toBeNull();
    expect(repository.list()[0]?.chat.messages).toHaveLength(200);
  });

  it("pages large message histories by UTF-8 bytes without skipping or truncating the boundary row", async () => {
    const db = await database();
    const repository = new SqliteConversationRepository(db, "Owner");
    await repository.create(chat());
    const text = "漢".repeat(95_000);
    for (let index = 0; index < 19; index++)
      await repository.appendMessage("first", { id: `large-${index}`, type: "incoming", text, status: "complete" });
    const ids: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = repository.messages("first", before, 200);
      pages++;
      const response = JSON.stringify({ ok: true, value: page });
      expect(Buffer.byteLength(response)).toBeLessThan(2 * 1024 * 1024 + 1024);
      expect(Buffer.byteLength(response)).toBeLessThan(16 * 1024 * 1024);
      expect(page.messages.length).toBeGreaterThan(0);
      for (const message of page.messages) expect(message.text).toBe(text);
      ids.unshift(...page.messages.map((message) => message.id!));
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(pages).toBe(3);
    expect(ids).toEqual(Array.from({ length: 19 }, (_, index) => `large-${index}`));
    expect(new Set(ids).size).toBe(19);
  });

  it("persists a streamed assistant response above the desktop text limit without truncating checkpoints", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-long-response-"));
    directories.push(directory);
    const server = await createWispServer({ dataDirectory: directory, port: 0, agentMode: "fake", admin: false });
    servers.push(server);
    await server.backend.conversations.create(chat() as import("../shared/conversations.js").Chat);
    const messageId = "long-response:assistant";
    server.backend.registry.publishExternalEvent({
      type: "assistant_message_started",
      conversationId: "first",
      requestId: "long-response",
      messageId,
      createdAt: new Date().toISOString(),
    });
    const chunk = "a".repeat(40_000);
    for (let index = 0; index < 5; index++)
      server.backend.registry.publishExternalEvent({
        type: "assistant_text_delta",
        conversationId: "first",
        requestId: "long-response",
        messageId,
        delta: chunk,
      });
    server.backend.registry.publishExternalEvent({
      type: "assistant_message_completed",
      conversationId: "first",
      requestId: "long-response",
      messageId,
    });
    const saved = server.repository.messages("first").messages.find((message) => message.id === messageId)!;
    expect(saved.text).toBe(chunk.repeat(5));
    expect(saved.status).toBe("complete");
  });

  it("recovers only never-started queued requests and marks uncertain running work interrupted", async () => {
    const db = await database();
    const directory = db.directory;
    const repository = new SqliteConversationRepository(db, "Owner");
    await repository.create(chat());
    const insert = db.sql.prepare(
      "INSERT INTO requests(conversation_id,id,payload_hash,payload,status,revision,updated_at) VALUES (?,?,?,?,?,?,?)",
    );
    insert.run(
      "first",
      "uncertain",
      "hash",
      JSON.stringify({ conversationId: "first", requestId: "uncertain", text: "Must not replay" }),
      "running",
      1,
      new Date().toISOString(),
    );
    insert.run(
      "first",
      "queued",
      "hash",
      JSON.stringify({ conversationId: "first", requestId: "queued", text: "Run first time" }),
      "queued",
      1,
      new Date().toISOString(),
    );
    db.sql.prepare("INSERT INTO approvals(id,request,state) VALUES (?,?,'pending')").run("old-approval", "{}");
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const server = await createWispServer({
      dataDirectory: directory,
      port: 0,
      agentMode: "fake",
      fakeLatencyMs: 1,
      admin: false,
    });
    servers.push(server);
    for (let count = 0; count < 100 && server.executor.request("first", "queued").status !== "completed"; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.executor.request("first", "uncertain").status).toBe("interrupted");
    expect(server.executor.request("first", "queued").status).toBe("completed");
    expect(server.repository.messages("first").messages.filter((message) => message.type === "incoming")).toHaveLength(
      1,
    );
    expect(server.database.sql.prepare("SELECT state FROM approvals WHERE id='old-approval'").get()?.state).toBe(
      "expired",
    );
  });

  it("rotates refresh tokens with a bounded lost-response retry and durable revocation", async () => {
    const db = await database();
    let now = Date.now();
    const auth = new DeviceAuth(db, () => now);
    const credentials = auth.pair(auth.createPairingCode().code, "Desktop", "127.0.0.1");
    const rotated = auth.refresh(credentials.refreshToken);
    expect(rotated.refreshToken).not.toBe(credentials.refreshToken);
    expect(auth.refresh(credentials.refreshToken)).toEqual(rotated);
    expect(new DeviceAuth(db, () => now).refresh(credentials.refreshToken)).toEqual(rotated);
    now += 30_001;
    expect(() => auth.refresh(credentials.refreshToken)).toThrow("expired");
    expect(new DeviceAuth(db, () => now).authenticate(rotated.accessToken).deviceId).toBe(rotated.deviceId);
    auth.revoke(rotated.deviceId);
    expect(() => auth.authenticate(rotated.accessToken)).toThrow("revoked");
    expect(() => auth.refresh(rotated.refreshToken)).toThrow("revoked");
    const rows = JSON.stringify(db.sql.prepare("SELECT * FROM tokens").all());
    expect(rows).not.toContain(credentials.refreshToken);
  });

  it("encrypts credentials with authenticated envelopes, rotates key IDs, and fails without a key", () => {
    const oldKey = randomBytes(32),
      newKey = randomBytes(32);
    const old = new MasterKeyEncryption(oldKey);
    const encrypted = old.encrypt("provider-secret");
    expect(encrypted.toString()).not.toContain("provider-secret");
    expect(new MasterKeyEncryption(newKey, [oldKey]).decrypt(encrypted)).toBe("provider-secret");
    const envelope = JSON.parse(encrypted.toString());
    envelope.payload = Buffer.from("tampered").toString("base64");
    expect(() => old.decrypt(Buffer.from(JSON.stringify(envelope)))).toThrow();
    expect(new MasterKeyEncryption().isAvailable()).toBe(false);
    expect(() => new MasterKeyEncryption().encrypt("secret")).toThrow("master key");
    expect(() => new MasterKeyEncryption(newKey).decrypt(encrypted)).toThrow("unavailable");
  });

  it("rewrites existing provider credentials using the new master key without exposing plaintext", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-rotation-"));
    directories.push(directory);
    const file = path.join(directory, "credentials.enc.json");
    const oldKey = randomBytes(32),
      newKey = randomBytes(32);
    await new EncryptedCredentialStore(file, new MasterKeyEncryption(oldKey)).setApiKey(
      "provider",
      "private-key-value",
    );
    await new EncryptedCredentialStore(file, new MasterKeyEncryption(newKey, [oldKey])).rotateEncryption();
    expect(await new EncryptedCredentialStore(file, new MasterKeyEncryption(newKey)).read("provider")).toEqual({
      type: "api_key",
      key: "private-key-value",
    });
    await expect(new EncryptedCredentialStore(file, new MasterKeyEncryption(oldKey)).read("provider")).rejects.toThrow(
      "unavailable",
    );
  });

  it("preserves four active agents, eight pending commands, and conversation-scoped cancellation IDs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-queue-"));
    directories.push(directory);
    const server = await createWispServer({
      dataDirectory: directory,
      port: 0,
      agentMode: "fake",
      fakeLatencyMs: 100,
      admin: false,
    });
    servers.push(server);
    for (let index = 0; index < 5; index++)
      await server.backend.conversations.create(chat(`wisp-${index}`) as import("../shared/conversations.js").Chat);
    for (let index = 0; index < 5; index++)
      server.executor.admit({
        conversationId: `wisp-${index}`,
        requestId: "same-request-id",
        text: `Response for ${index}`,
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.database.sql.prepare("SELECT COUNT(*) AS n FROM requests WHERE status='running'").get()?.n).toBe(4);
    await server.executor.abort("wisp-0");
    for (let count = 0; count < 100 && server.executor.pending() > 0; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.executor.request("wisp-0", "same-request-id").status).toBe("cancelled");
    for (let index = 1; index < 5; index++) {
      expect(server.executor.request(`wisp-${index}`, "same-request-id").status).toBe("completed");
      expect(
        server.repository.messages(`wisp-${index}`).messages.find((message) => message.type === "incoming")?.text,
      ).toBe(`Fake response to: Response for ${index}`);
    }
    for (let index = 0; index < 8; index++)
      server.executor.admit({ conversationId: "wisp-0", requestId: `queued-${index}`, text: "Queued" });
    expect(() => server.executor.admit({ conversationId: "wisp-0", requestId: "too-many", text: "Rejected" })).toThrow(
      "eight pending",
    );
    await server.executor.abort("wisp-0");
    for (let count = 0; count < 100 && server.executor.pending() > 0; count++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (let index = 0; index < 8; index++)
      expect(server.executor.request("wisp-0", `queued-${index}`).status).toBe("cancelled");
    expect(
      server.repository
        .messages("wisp-0")
        .messages.filter((message) => message.type === "outgoing" && message.id?.startsWith("queued-"))
        .every((message) => message.status === "cancelled"),
    ).toBe(true);
  });
});
