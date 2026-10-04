import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ConversationRepository } from "../electron/backend/conversation-repository.js";
import { CONVERSATION_STORAGE_POLICY } from "../electron/backend/storage-policy.js";
import type { Chat, Message } from "../shared/conversations.js";

async function reload(directory: string): Promise<ConversationRepository> {
  const repository = new ConversationRepository({ dataDirectory: directory });
  await repository.load();
  return repository;
}

/** Raw rows as stored, bypassing the repository. */
function storedRecord(directory: string, id: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(directory, "conversations.sqlite"));
  try {
    const row = db.prepare("SELECT record FROM conversations WHERE id = ?").get(id);
    return JSON.parse(String(row?.record)) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function chat(id: string, circle = false): Chat {
  const base = {
    id,
    name: id,
    label: "Test",
    description: "A test conversation",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [{ type: "incoming", text: "Hello" }],
  };
  return circle ? { ...base, kind: "circle", memberIds: [] } : { ...base, kind: "wisp", shape: "circle" };
}

describe("ConversationRepository", () => {
  it("imports legacy conversations once and keeps stable message and session IDs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-repository-"));
    let nextId = 0;
    const repository = new ConversationRepository({
      dataDirectory: directory,
      createId: () => `generated-${++nextId}`,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await repository.load();
    await repository.initialize({ first: chat("first") });
    const firstRecord = repository.list()[0];
    await repository.initialize({ second: chat("second") });

    expect(repository.getChats()).toHaveProperty("first");
    expect(repository.getChats()).not.toHaveProperty("second");
    expect(repository.list()[0]?.sessionId).toBe(firstRecord?.sessionId);
    expect(repository.getChats().first?.messages[0]?.id).toBe("first:message:0");
    const context = repository.getAgentContext("first");
    await expect(readdir(context.workspaceDirectory)).resolves.toEqual([]);
    await expect(readdir(context.sessionDirectory)).resolves.toEqual([]);
    await expect(readdir(context.configDirectory)).resolves.toEqual([]);

    const piSessionFile = path.join(context.sessionDirectory, "history.jsonl");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-history-id",
      sessionFile: piSessionFile,
    });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getAgentContext("first")).toEqual(
      expect.objectContaining({
        piSessionId: "pi-history-id",
        piSessionFile,
      }),
    );
    await expect(
      restored.savePiSessionIdentity("first", {
        sessionId: "unsafe-history",
        sessionFile: path.join(directory, "outside.jsonl"),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(restored.getAgentContext("first").piSessionId).toBe("pi-history-id");
  });

  it("persists profile context across restarts, rejects invalid input, and clears it for every Wisp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-profile-"));
    const repository = await reload(directory);
    await repository.initialize({ first: chat("first"), second: chat("second") });
    const profile = { preferredName: "Ada", aboutYou: "Backend developer", responsePreferences: "Be concise" };
    await repository.saveUserProfile(profile);
    const restored = await reload(directory);
    expect(restored.getUserProfile()).toEqual(profile);
    for (const context of restored.listAgentContexts()) {
      expect(context.userName).toBe("Ada");
      expect(context.userProfile).toEqual(profile);
    }
    await expect(restored.saveUserProfile({ ...profile, aboutYou: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(restored.getUserProfile()).toEqual(profile);
    const empty = { preferredName: "", aboutYou: "", responsePreferences: "" };
    await restored.saveUserProfile(empty);
    expect((await reload(directory)).getUserProfile()).toEqual(empty);
    expect(restored.getAgentContext("first").userName).toBeUndefined();
    expect(restored.getAgentContext("second").userProfile).toEqual(empty);
  });

  it("includes the configured user name in every agent context", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-user-context-"));
    const repository = new ConversationRepository({ dataDirectory: directory, userName: "  John\nDoe  " });
    await repository.initialize({ first: chat("first"), second: chat("second") });

    expect(repository.getAgentContext("first")).toEqual(expect.objectContaining({ userName: "John Doe" }));
    expect(repository.listAgentContexts()).toEqual([
      expect.objectContaining({ conversationId: "first", userName: "John Doe" }),
      expect.objectContaining({ conversationId: "second", userName: "John Doe" }),
    ]);
  });

  it("persists a creation-time model override with the new Wisp and restores it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-override-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await repository.create(chat("plain"), null);
    const override = { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 };
    await repository.create(chat("custom"), override);

    expect(repository.getAgentContext("plain").modelOverride).toBeNull();
    expect(repository.getAgentContext("custom").modelOverride).toEqual(override);

    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getAgentContext("custom").modelOverride).toEqual(override);
    expect(restored.getAgentContext("plain").modelOverride).toBeNull();
  });

  it("rejects creation-time model overrides that are invalid or belong to circles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-override-invalid-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();

    await expect(
      repository.create(chat("bad"), { providerId: "", modelId: "claude-sonnet-4-5" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.create(chat("circle", true), { providerId: "anthropic", modelId: "m" }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats()).not.toHaveProperty("bad");
    expect(repository.getChats()).not.toHaveProperty("circle");
  });

  it("upgrades Phase 3 records without losing their stable application session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-schema-upgrade-"));
    await writeFile(
      path.join(directory, "conversations.json"),
      JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        conversations: {
          first: {
            chat: chat("first"),
            sessionId: "stable-app-session",
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    const upgraded = expect.objectContaining({
      sessionId: "stable-app-session",
      piSessionId: null,
      piSessionFile: null,
    });
    expect(repository.getAgentContext("first")).toEqual(upgraded);
    expect((await reload(directory)).getAgentContext("first")).toEqual(upgraded);
    // The JSON store is kept, untouched, as the migration backup.
    const files = await readdir(directory);
    expect(files).not.toContain("conversations.json");
    const backup = files.find((name) => name.startsWith("conversations.json.migrated-"));
    expect(backup).toBeDefined();
    expect(JSON.parse(await readFile(path.join(directory, backup!), "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("imports the legacy JSON store only once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-migrate-once-"));
    const legacy = (ids: string[]) =>
      JSON.stringify({
        schemaVersion: 4,
        initialized: true,
        conversations: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              chat: chat(id),
              sessionId: `${id}-session`,
              piSessionId: null,
              piSessionFile: null,
              createdAt: "2026-08-30T12:00:00.000Z",
              updatedAt: "2026-08-30T12:00:00.000Z",
            },
          ]),
        ),
      });
    await writeFile(path.join(directory, "conversations.json"), legacy(["first"]), "utf8");
    await reload(directory);
    // An older build started afterwards could write a new JSON store; SQLite stays authoritative.
    await writeFile(path.join(directory, "conversations.json"), legacy(["stale"]), "utf8");

    const restarted = await reload(directory);

    expect(Object.keys(restarted.getChats())).toEqual(["first"]);
  });

  it("removes previously persisted bundled demo conversations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-demo-removal-"));
    await writeFile(
      path.join(directory, "conversations.json"),
      JSON.stringify({
        schemaVersion: 2,
        initialized: true,
        conversations: {
          chief: {
            chat: chat("chief"),
            sessionId: "demo-session",
            piSessionId: null,
            piSessionFile: null,
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
          custom: {
            chat: chat("custom"),
            sessionId: "custom-session",
            piSessionId: null,
            piSessionFile: null,
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.getChats()).toEqual({ custom: expect.objectContaining({ id: "custom" }) });
    expect((await reload(directory)).getChats()).toEqual({ custom: expect.objectContaining({ id: "custom" }) });
  });

  it("upserts stable message IDs without duplicating streamed lifecycle updates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-upsert-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });

    await repository.appendMessage("first", {
      id: "request-1:assistant",
      type: "incoming",
      text: "Partial",
      status: "streaming",
      createdAt: "2026-08-31T23:10:00.000Z",
    });
    await repository.appendMessage("first", {
      id: "request-1:assistant",
      type: "incoming",
      text: "Complete response",
      status: "complete",
      createdAt: "2026-08-31T23:10:00.000Z",
    });

    const matching = repository.getChats().first?.messages.filter(({ id }) => id === "request-1:assistant");
    expect(matching).toEqual([
      expect.objectContaining({
        text: "Complete response",
        status: "complete",
        createdAt: "2026-08-31T23:10:00.000Z",
      }),
    ]);
  });

  it("preserves a corrupt state file before recovering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-corrupt-"));
    const statePath = path.join(directory, "conversations.json");
    await writeFile(statePath, "{ definitely not json", "utf8");
    const repository = new ConversationRepository({
      dataDirectory: directory,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    await repository.load();

    expect(repository.didRecoverCorruptState()).toBe(true);
    expect(repository.isInitialized()).toBe(false);
    const preserved = (await readdir(directory)).find((name) => name.includes(".corrupt-"));
    expect(preserved).toBeDefined();
    await expect(readFile(path.join(directory, preserved!), "utf8")).resolves.toBe("{ definitely not json");
  });

  it("rewrites schema-3 boolean records as discriminated variants", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-kind-migration-"));
    const statePath = path.join(directory, "conversations.json");
    const { kind: _kind, ...currentWisp } = chat("chief");
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 3,
        initialized: true,
        conversations: {
          chief: {
            chat: { ...currentWisp, isCircle: false },
            sessionId: "stable-session",
            piSessionId: null,
            piSessionFile: null,
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.getChats().chief).toMatchObject({ kind: "wisp", systemRole: "chief" });
    const stored = storedRecord(directory, "chief") as { chat: Record<string, unknown> };
    expect(stored.chat).not.toHaveProperty("isCircle");
    expect(stored.chat).toHaveProperty("kind", "wisp");
    // Messages live in their own rows, not inside the conversation record.
    expect(stored.chat).not.toHaveProperty("messages");
  });

  it("archives workspace and session data on explicit deletion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-delete-"));
    const repository = new ConversationRepository({
      dataDirectory: directory,
      createId: () => "stable-session",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await repository.initialize({ first: chat("first") });

    await repository.delete("first");

    expect(repository.getChats()).toEqual({});
    const archives = await readdir(path.join(directory, "deleted-conversations"));
    expect(archives).toHaveLength(1);
    const contents = await readdir(path.join(directory, "deleted-conversations", archives[0]!));
    expect(contents.sort()).toEqual(["pi-config", "pi-session", "workspace"]);
  });

  it("enforces protected deletion and preserves the stored graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-protected-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ leader: { ...chat("leader"), systemRole: "chief" } });

    await expect(repository.delete("leader")).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats().leader).toMatchObject({ id: "leader", systemRole: "chief" });
  });

  it("persists member pruning in the same deletion transaction", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({
      first: chat("first"),
      second: chat("second"),
      crew: { ...chat("crew", true), memberIds: ["second", "first"] },
    });

    await repository.delete("first");

    expect(repository.getChats().crew).toMatchObject({ memberIds: ["second"] });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getChats().crew).toMatchObject({ memberIds: ["second"] });
  });

  it("normalizes and persists an ordered circle membership replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-update-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({
      first: chat("first"),
      second: chat("second"),
      crew: { ...chat("crew", true), memberIds: [] },
    });

    await repository.update("crew", { kind: "circle", memberIds: ["second", "first", "second"] });

    expect(repository.getChats().crew).toMatchObject({ memberIds: ["second", "first"] });
    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getChats().crew).toMatchObject({ memberIds: ["second", "first"] });
  });

  it("rolls back an invalid circle membership replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-invalid-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first"), crew: { ...chat("crew", true), memberIds: ["first"] } });

    await expect(repository.update("crew", { kind: "circle", memberIds: ["missing"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(repository.getChats().crew).toMatchObject({ memberIds: ["first"] });
  });

  it("rejects unsafe avatars and invalid circle membership as one graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-invalid-graph-"));
    const repository = new ConversationRepository({ dataDirectory: directory });

    await expect(
      repository.initialize({ first: { ...chat("first"), avatarImage: "data:image/png;base64,AAAA" } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.initialize({
        first: chat("first"),
        crew: { ...chat("crew", true), memberIds: ["first", "first"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.initialize({ crew: { ...chat("crew", true), memberIds: ["missing"] } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(repository.getChats()).toEqual({});
  });

  it("rolls back in-memory state when persistence cannot complete", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-write-failure-"));
    const blockedPath = path.join(directory, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    const repository = new ConversationRepository({ dataDirectory: blockedPath });

    await expect(repository.initialize({ first: chat("first") })).rejects.toBeDefined();

    expect(repository.isInitialized()).toBe(false);
    expect(repository.getChats()).toEqual({});
  });

  it("rolls back every kind of mutation when a later write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-rollback-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await repository.initialize({ first: chat("first") });
    const before = repository.list();
    const { sessionDirectory } = repository.getAgentContext("first");
    // Every write to either table now aborts, as a full disk or I/O error would.
    const saboteur = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    saboteur.exec(`
      CREATE TRIGGER fail_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_conversation_update BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    saboteur.close();

    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Not saved" }),
    ).rejects.toBeDefined();
    await expect(
      repository.setModelOverride("first", { providerId: "anthropic", modelId: "claude-sonnet-5" }),
    ).rejects.toBeDefined();
    await expect(
      repository.savePiSessionIdentity("first", {
        sessionId: "pi-new",
        sessionFile: path.join(sessionDirectory, "history.jsonl"),
      }),
    ).rejects.toBeDefined();
    await expect(repository.update("first", { kind: "wisp", name: "Renamed" })).rejects.toBeDefined();

    expect(repository.list()).toEqual(before);
    // Nothing partial reached the disk either.
    expect((await reload(directory)).list()).toEqual(before);
  });

  it("restores every kind of change after a restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-round-trip-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await repository.initialize({ first: chat("first"), second: chat("second") });
    await repository.create({ ...chat("circle", true), memberIds: ["first", "second"] });
    await repository.appendMessage("first", { id: "reply", type: "incoming", text: "Streaming", status: "streaming" });
    await repository.appendMessage("first", { id: "reply", type: "incoming", text: "Done", status: "complete" });
    await repository.appendMessage("first", {
      id: "question",
      type: "prompt",
      question: "Proceed?",
      options: [{ key: "yes", label: "Yes" }],
    });
    await repository.answerPrompt("first", "question", "yes");
    await repository.update("first", { kind: "wisp", name: "Renamed", unread: true });
    await repository.markRead("first");
    await repository.setModelOverride("first", { providerId: "openrouter", modelId: "openai/gpt-oss-120b" });
    const { sessionDirectory } = repository.getAgentContext("first");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-first",
      sessionFile: path.join(sessionDirectory, "history.jsonl"),
    });
    await repository.delete("second");
    await repository.close();

    const restarted = await reload(directory);

    expect(restarted.list()).toEqual(repository.list());
    expect(restarted.getChats().circle).toMatchObject({ memberIds: ["first"] });
    expect(restarted.getChats().first?.messages.map(({ id }) => id)).toEqual(["first:message:0", "reply", "question"]);
  });

  it("keeps the newest messages when a conversation reaches its limit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-limit-"));
    const limit = CONVERSATION_STORAGE_POLICY.maxMessagesPerConversation;
    const full: Message[] = Array.from({ length: limit }, (_, index) => ({
      id: `m${index}`,
      type: "incoming",
      text: `Message ${index}`,
    }));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: { ...chat("first"), messages: full } });

    await repository.appendMessage("first", { id: "newest", type: "outgoing", text: "Still sends" });

    for (const current of [repository, await reload(directory)]) {
      const ids = current.getChats().first!.messages.map(({ id }) => id);
      expect(ids).toHaveLength(limit);
      expect(ids[0]).toBe("m1");
      expect(ids.at(-1)).toBe("newest");
    }
  });

  it("gives duplicate legacy message IDs unique replacements instead of dropping messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-duplicate-ids-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const messages: Message[] = [
      { id: "same", type: "incoming", text: "First" },
      { id: "same", type: "incoming", text: "Second" },
    ];
    await repository.initialize({ first: { ...chat("first"), messages } });

    const restored = (await reload(directory)).getChats().first!.messages;

    expect(restored.map((message) => ("text" in message ? message.text : ""))).toEqual(["First", "Second"]);
    expect(new Set(restored.map(({ id }) => id)).size).toBe(2);
  });

  it.each([
    ["not a database", async (file: string) => writeFile(file, "definitely not sqlite", "utf8")],
    [
      "from a newer app version",
      async (file: string) => {
        const db = new DatabaseSync(file);
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
        db.exec("INSERT INTO meta VALUES ('store_version', '99')");
        db.close();
      },
    ],
  ])("preserves a database that is %s and starts fresh", async (_label, prepare) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-corrupt-db-"));
    await prepare(path.join(directory, "conversations.sqlite"));
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.didRecoverCorruptState()).toBe(true);
    expect(repository.isInitialized()).toBe(false);
    expect((await readdir(directory)).some((name) => name.startsWith("conversations.sqlite.corrupt-"))).toBe(true);
    await repository.initialize({ first: chat("first") });
    expect(Object.keys((await reload(directory)).getChats())).toEqual(["first"]);
  });

  it("keeps each chat's last activity, never moving it backwards", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-last-activity-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    const earlier = { id: "earlier", type: "incoming" as const, text: "A", createdAt: "2026-09-10T10:00:00.000Z" };
    await repository.initialize({
      first: { ...chat("first"), messages: [earlier] },
      silent: { ...chat("silent"), messages: [], timestamp: "2026-09-05T00:00:00.000Z" },
      legacy: { ...chat("legacy"), messages: [{ type: "incoming", text: "Untimed" }], timestamp: "Yesterday" },
    });
    expect(repository.getChats().first?.lastActivityAt).toBe(earlier.createdAt);
    expect(repository.getChats().silent?.lastActivityAt).toBe("2026-09-05T00:00:00.000Z");
    expect(repository.getChats().legacy).not.toHaveProperty("lastActivityAt");

    await repository.appendMessage("first", {
      id: "newer",
      type: "outgoing",
      text: "B",
      createdAt: "2026-09-12T08:00:00.000Z",
    });
    // A late status update for an older message must not move activity back.
    await repository.appendMessage("first", { ...earlier, status: "complete" });

    expect(repository.getChats().first?.lastActivityAt).toBe("2026-09-12T08:00:00.000Z");
    expect((await reload(directory)).getChats().first?.lastActivityAt).toBe("2026-09-12T08:00:00.000Z");
  });

  it("reads pages through the repository and reports missing conversations and messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-repository-pages-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });

    await expect(repository.getMessagePage({ conversationId: "first", page: "latest" })).resolves.toEqual({
      messages: [expect.objectContaining({ id: "first:message:0", text: "Hello", status: "complete" })],
      olderCursor: null,
      newerCursor: null,
    });
    await expect(repository.getMessagePage({ conversationId: "missing", page: "latest" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      repository.getMessagePage({ conversationId: "first", page: "around", messageId: "gone" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports whether a write added a message or updated one, with the stored message", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-message-changes-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });

    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Streaming", status: "streaming" }),
    ).resolves.toMatchObject({ added: true, message: { id: "reply", text: "Streaming" } });
    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Done", status: "complete" }),
    ).resolves.toMatchObject({ added: false, message: { id: "reply", text: "Done" } });
    await expect(
      repository.appendOutgoingMessage("first", { id: "request-1", type: "outgoing", text: "Hi" }),
    ).resolves.toMatchObject({ added: true, message: { id: "request-1" } });
    await repository.appendMessage("first", {
      id: "question",
      type: "prompt",
      question: "Proceed?",
      options: [{ key: "yes", label: "Yes" }],
    });
    await expect(repository.answerPrompt("first", "question", "yes")).resolves.toMatchObject({
      id: "question",
      answer: "yes",
    });
  });

  it("updates delivery status only for stored outgoing messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-outgoing-status-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });
    await repository.appendMessage("first", { id: "request-1", type: "outgoing", text: "Hi", status: "queued" });

    await expect(repository.setOutgoingStatus("first", "request-1", "complete")).resolves.toMatchObject({
      id: "request-1",
      status: "complete",
    });
    await expect(repository.setOutgoingStatus("first", "first:message:0", "failed")).resolves.toBeUndefined();
    await expect(repository.setOutgoingStatus("first", "missing", "failed")).resolves.toBeUndefined();

    await expect(repository.getMessage("first", "request-1")).resolves.toMatchObject({ status: "complete" });
    await expect(repository.getMessage("first", "first:message:0")).resolves.toMatchObject({ status: "complete" });
  });
});
