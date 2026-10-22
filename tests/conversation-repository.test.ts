import { cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ConversationRepository } from "../backend/conversation-repository.js";
import { CONVERSATION_STORAGE_POLICY } from "../backend/storage-policy.js";
import type { Chat, CircleChat, Message, Wisp } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE, appearanceFromLegacyShape } from "../shared/wisp-appearance.js";

async function reload(directory: string): Promise<ConversationRepository> {
  const repository = new ConversationRepository({ dataDirectory: directory });
  await repository.load();
  return repository;
}

/** Raw rows as stored, bypassing the repository. */
function storedRows(directory: string, sql: string, ...parameters: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path.join(directory, "conversations.sqlite"));
  try {
    return db.prepare(sql).all(...parameters);
  } finally {
    db.close();
  }
}

/** A store as layout 3 wrote it: whole records as JSON. */
function createJsonStore(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "conversations.sqlite"));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE conversations (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (conversation_id, id)) STRICT;
    CREATE TABLE scheduled_messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      next_run_at TEXT NOT NULL, record TEXT NOT NULL) STRICT;
    CREATE TABLE queued_messages (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      record TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('store_version', '3'), ('min_reader_version', '1'), ('initialized', '1');
  `);
  return db;
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

function newWisp(id: string): Wisp {
  return { id, name: id, role: "Test", soul: "A test Wisp", appearance: DEFAULT_WISP_APPEARANCE };
}

function circle(id: string, memberIds: string[] = []): CircleChat {
  return {
    id,
    kind: "circle",
    name: id,
    label: "Circle",
    description: "",
    memberIds,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    messages: [],
  };
}

/** A conversation record as stores before Wisps were stored apart wrote it. */
function legacyRecord(id: string, overrides: Record<string, unknown> = {}) {
  const { messages: _messages, ...legacyChat } = chat(id) as Chat & Record<string, unknown>;
  return {
    chat: { ...legacyChat, ...overrides },
    sessionId: `${id}-session`,
    modelOverride: null,
    piSessionId: null,
    piSessionFile: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
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
    expect(repository.list()[0]?.storageId).toBe(firstRecord?.storageId);
    expect(repository.readWisps().first).toEqual({
      id: "first",
      name: "first",
      role: "Test",
      soul: "A test conversation",
      appearance: appearanceFromLegacyShape("circle"),
    });
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

  it("leaves out the bundled demo conversations early versions kept in local storage", async () => {
    const repository = await reload(await mkdtemp(path.join(os.tmpdir(), "wisp-demo-")));
    await repository.initialize({ chief: chat("chief"), first: chat("first") });

    expect(Object.keys(repository.readWisps())).toEqual(["first"]);
    expect(Object.keys(repository.getChats())).toEqual(["first"]);
  });

  it("finds Pi sessions after its data directory moves, such as a restored backup", async () => {
    const original = await mkdtemp(path.join(os.tmpdir(), "wisp-original-"));
    const repository = await reload(original);
    await repository.initialize({ first: chat("first") });
    const { sessionDirectory } = repository.getAgentContext("first");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-history-id",
      sessionFile: path.join(sessionDirectory, "history.jsonl"),
    });
    await repository.close();

    const moved = path.join(await mkdtemp(path.join(os.tmpdir(), "wisp-moved-")), "data");
    await cp(original, moved, { recursive: true });
    const restored = await reload(moved);
    const context = restored.getAgentContext("first");
    expect(context.piSessionFile).toBe(path.join(context.sessionDirectory, "history.jsonl"));
    expect(context.piSessionFile?.startsWith(moved)).toBe(true);
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

  it("keeps the reported time zone across restarts and gives every Wisp the current one", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-time-zone-"));
    const repository = await reload(directory);
    await repository.initialize({ first: chat("first") });
    const context = repository.getAgentContext("first");
    await repository.saveUserTimeZone("Asia/Tokyo");
    expect(context.userTimeZone?.()).toBe("Asia/Tokyo");
    await expect(repository.saveUserTimeZone("Mars/Olympus")).rejects.toMatchObject({ code: "invalid_request" });
    const restored = await reload(directory);
    expect(restored.getUserTimeZone()).toBe("Asia/Tokyo");
    expect(restored.getAgentContext("first").userTimeZone?.()).toBe("Asia/Tokyo");
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
    await repository.createWisp(newWisp("plain"), { notifyOnUpdatesEnabled: true, modelOverride: null });
    const override = { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 };
    await repository.createWisp(newWisp("custom"), { notifyOnUpdatesEnabled: true, modelOverride: override });

    expect(repository.getAgentContext("plain").modelOverride).toBeNull();
    expect(repository.getAgentContext("custom").modelOverride).toEqual(override);

    const restored = new ConversationRepository({ dataDirectory: directory });
    await restored.load();
    expect(restored.getAgentContext("custom").modelOverride).toEqual(override);
    expect(restored.getAgentContext("plain").modelOverride).toBeNull();
  });

  it("gives each conversation its creation time, which survives a restart and later changes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-created-at-"));
    let now = new Date("2026-10-01T10:00:00.000Z");
    const repository = new ConversationRepository({ dataDirectory: directory, now: () => now });
    await repository.load();
    await repository.createWisp(newWisp("first"), { notifyOnUpdatesEnabled: true, modelOverride: null });
    now = new Date("2026-10-02T10:00:00.000Z");
    await repository.create({ ...circle("team", ["first"]), createdAt: "2020-01-01T00:00:00.000Z" });
    now = new Date("2026-10-03T10:00:00.000Z");
    await repository.markUnread("first");

    expect(repository.getChats().first?.createdAt).toBe("2026-10-01T10:00:00.000Z");
    // The backend decides when a conversation was created, not the client.
    expect(repository.getChats().team?.createdAt).toBe("2026-10-02T10:00:00.000Z");

    const restored = await reload(directory);
    expect(restored.getChats().first?.createdAt).toBe("2026-10-01T10:00:00.000Z");
    expect(restored.getChats().team?.createdAt).toBe("2026-10-02T10:00:00.000Z");
  });

  it("rejects invalid model overrides and a Wisp's conversation created without its Wisp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-override-invalid-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();

    await expect(
      repository.createWisp(newWisp("bad"), {
        notifyOnUpdatesEnabled: true,
        modelOverride: { providerId: "", modelId: "claude-sonnet-4-5" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      repository.create({
        id: "orphan",
        kind: "wisp",
        wispId: "orphan",
        notifyOnUpdatesEnabled: true,
        preview: "",
        messages: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats()).toEqual({});
    expect(repository.readWisps()).toEqual({});
  });

  it("creates a Wisp with its own conversation, folders, and session, and changes it apart from them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-create-"));
    let nextId = 0;
    const repository = new ConversationRepository({ dataDirectory: directory, createId: () => `id-${++nextId}` });
    await repository.load();
    await repository.createWisp(newWisp("atlas"), { notifyOnUpdatesEnabled: false });

    expect(repository.readWisps().atlas).toEqual(newWisp("atlas"));
    expect(repository.getChats().atlas).toMatchObject({
      kind: "wisp",
      wispId: "atlas",
      notifyOnUpdatesEnabled: false,
      preview: "Ready for the first task.",
    });
    const context = repository.getAgentContext("atlas");
    // The Wisp's settings, the conversation's workspace, and the session each have their own folder.
    expect(context).toMatchObject({
      wispId: "atlas",
      role: "Test",
      soul: "A test Wisp",
      configDirectory: path.join(directory, "wisp-config", "id-1"),
      workspaceDirectory: path.join(directory, "workspaces", "id-2"),
      sessionDirectory: path.join(directory, "wisp-sessions", "id-3"),
    });
    expect(repository.getWispStorageId("atlas")).toBe("id-1");

    await repository.updateWisp("atlas", { soul: "# Identity\nA careful researcher", color: "#123456" });
    await repository.updateWisp("atlas", { color: undefined });
    const restored = await reload(directory);
    expect(restored.readWisps().atlas).toEqual({ ...newWisp("atlas"), soul: "# Identity\nA careful researcher" });
    expect(restored.getAgentContext("atlas").soul).toBe("# Identity\nA careful researcher");
    await expect(restored.updateWisp("missing", { name: "Ghost" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("moves a data directory's Pi-named folders to the new names when it loads, keeping each Wisp's files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-folders-"));
    let nextId = 0;
    const created = new ConversationRepository({ dataDirectory: directory, createId: () => `id-${++nextId}` });
    await created.load();
    await created.createWisp(newWisp("atlas"), { notifyOnUpdatesEnabled: false });
    const { configDirectory, sessionDirectory } = created.getAgentContext("atlas");
    await created.savePiSessionIdentity("atlas", {
      sessionId: "pi-1",
      sessionFile: path.join(sessionDirectory, "history.jsonl"),
    });
    await created.close();
    await writeFile(path.join(configDirectory, "memory.md"), "likes tea");
    await writeFile(path.join(sessionDirectory, "history.jsonl"), "{}\n");
    // Put the folders back under the names this data directory had before.
    await rename(path.join(directory, "wisp-config"), path.join(directory, "pi-config"));
    await rename(path.join(directory, "wisp-sessions"), path.join(directory, "pi-sessions"));
    const oldFile = path.join(directory, "pi-sessions", "id-3", "history.jsonl");
    const db = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    db.prepare("UPDATE participant_sessions SET pi_session_file = ?").run(oldFile);
    db.close();

    const upgraded = new ConversationRepository({ dataDirectory: directory });
    await upgraded.load();

    expect((await readdir(directory)).filter((name) => /^(pi|wisp)-/.test(name)).sort()).toEqual([
      "wisp-config",
      "wisp-sessions",
    ]);
    const context = upgraded.getAgentContext("atlas");
    expect(context.configDirectory).toBe(configDirectory);
    expect(await readFile(path.join(context.configDirectory, "memory.md"), "utf8")).toBe("likes tea");
    // The session file the old layout stored resolves to the same file under its new folder.
    expect(context.piSessionFile).toBe(path.join(sessionDirectory, "history.jsonl"));
    expect(await readFile(context.piSessionFile!, "utf8")).toBe("{}\n");
    await upgraded.close();
  });

  it("splits records saved before Wisps were stored apart, keeping their folders and tone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-split-"));
    const db = createJsonStore(directory);
    const sessionFile = path.join(directory, "wisp-sessions", "first-session", "history.jsonl");
    db.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)").run(
      "first",
      JSON.stringify({
        ...legacyRecord("first", {
          lastActivityAt: "2026-09-01T00:00:00.000Z",
          tone: { style: "formal", length: "short", custom: "" },
        }),
        modelOverride: { providerId: "anthropic", modelId: "claude-sonnet-5" },
        piSessionId: "pi-first",
        piSessionFile: sessionFile,
      }),
    );
    db.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)").run(
      "crew",
      JSON.stringify({
        ...legacyRecord("crew", { kind: "circle", memberIds: ["first"] }),
        sessionId: null,
      }),
    );
    db.prepare("INSERT INTO messages (conversation_id, id, body) VALUES (?, ?, ?)").run(
      "first",
      "m1",
      JSON.stringify({ id: "m1", type: "incoming", text: "Hello", createdAt: "2026-08-31T00:00:00.000Z" }),
    );
    const scheduled = {
      id: "s1",
      conversationId: "first",
      text: "Later",
      schedule: { kind: "once", at: "2026-12-01T09:00:00.000Z" },
      timeZone: "America/Sao_Paulo",
      nextRunAt: "2026-12-01T09:00:00.000Z",
      sentCount: 0,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    db.prepare("INSERT INTO scheduled_messages (id, conversation_id, next_run_at, record) VALUES (?, ?, ?, ?)").run(
      scheduled.id,
      scheduled.conversationId,
      scheduled.nextRunAt,
      JSON.stringify(scheduled),
    );
    const queued = {
      id: "q1",
      conversationId: "first",
      text: "Waiting",
      createdAt: "2026-08-31T00:00:00.000Z",
      scheduled: { scheduledMessageId: "s0", scheduledAt: "2026-08-30T00:00:00.000Z", timeZone: "UTC" },
    };
    db.prepare("INSERT INTO queued_messages (id, conversation_id, record) VALUES (?, ?, ?)").run(
      queued.id,
      queued.conversationId,
      JSON.stringify(queued),
    );
    db.close();

    const upgraded = await reload(directory);

    expect(upgraded.readWisps().first).toEqual({
      id: "first",
      name: "first",
      role: "Test",
      soul: [
        "A test conversation",
        "## Tone\nProfessional and polished. Use complete sentences and avoid slang, jokes, and emoji.",
        "## Response length\nKeep responses brief: a few sentences or a short list. Expand only when asked.",
      ].join("\n\n"),
      appearance: appearanceFromLegacyShape("circle"),
    });
    expect(upgraded.getChats().first).toMatchObject({
      kind: "wisp",
      wispId: "first",
      lastActivityAt: "2026-09-01T00:00:00.000Z",
      messages: [expect.objectContaining({ id: "m1" })],
    });
    expect(upgraded.getChats().crew).toMatchObject({ kind: "circle", memberIds: ["first"] });
    // One ID named all of the Wisp's folders, so it still does.
    expect(upgraded.getAgentContext("first")).toMatchObject({
      sessionId: "first-session",
      modelOverride: { providerId: "anthropic", modelId: "claude-sonnet-5" },
      piSessionId: "pi-first",
      piSessionFile: sessionFile,
      configDirectory: path.join(directory, "wisp-config", "first-session"),
      workspaceDirectory: path.join(directory, "workspaces", "first-session"),
      sessionDirectory: path.join(directory, "wisp-sessions", "first-session"),
    });
    expect(upgraded.getWispStorageId("first")).toBe("first-session");
    // The records were rewritten as columns, and the pending messages kept.
    expect(storedRows(directory, "SELECT * FROM conversations WHERE id = ?", "first")).toEqual([
      expect.objectContaining({ kind: "wisp", wisp_id: "first", storage_id: "first-session" }),
    ]);
    expect(storedRows(directory, "SELECT conversation_id, wisp_id, position FROM circle_members")).toEqual([
      { conversation_id: "crew", wisp_id: "first", position: 0 },
    ]);
    expect(storedRows(directory, "SELECT type, created_at FROM messages")).toEqual([
      { type: "incoming", created_at: "2026-08-31T00:00:00.000Z" },
    ]);
    expect(await upgraded.listScheduledMessages()).toEqual([scheduled]);
    expect(await upgraded.listQueuedMessages()).toEqual([queued]);
    expect(storedRows(directory, "SELECT key, value FROM meta WHERE key LIKE '%version'")).toEqual(
      expect.arrayContaining([
        { key: "store_version", value: "12" },
        { key: "min_reader_version", value: "12" },
      ]),
    );
    await upgraded.close();
    expect((await reload(directory)).readWisps()).toEqual(upgraded.readWisps());
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

    expect(repository.getChats().chief).toEqual(expect.objectContaining({ kind: "wisp", wispId: "chief" }));
    expect(repository.getChats().chief).not.toHaveProperty("systemRole");
    expect(repository.readWisps().chief).toMatchObject({ name: "chief", role: "Test" });
    expect(storedRows(directory, "SELECT kind, wisp_id, name FROM conversations WHERE id = ?", "chief")).toEqual([
      { kind: "wisp", wisp_id: "chief", name: null },
    ]);
  });

  it("archives workspace and session data on explicit deletion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-delete-"));
    const repository = new ConversationRepository({
      dataDirectory: directory,
      createId: () => "stable-session",
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });
    await repository.initialize({ first: chat("first") });
    const [storageId] = await readdir(path.join(directory, "wisp-config"));
    const cache = path.join(directory, "wisp-config", storageId!, "transcription-cache");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "entry.json"), JSON.stringify({ text: "Scanned contract" }));

    await repository.deleteWisp("first");

    expect(repository.getChats()).toEqual({});
    expect(repository.readWisps()).toEqual({});
    const archives = await readdir(path.join(directory, "deleted-conversations"));
    expect(archives).toHaveLength(1);
    const contents = await readdir(path.join(directory, "deleted-conversations", archives[0]!));
    expect(contents.sort()).toEqual(["archive.json", "wisp-config", "wisp-session", "workspace"]);
    // Storage names the archive from its manifest; the folder name is only an ID.
    expect(
      JSON.parse(await readFile(path.join(directory, "deleted-conversations", archives[0]!, "archive.json"), "utf8")),
    ).toEqual({ name: "first", kind: "wisp", archivedAt: "2026-08-30T12:00:00.000Z" });
    // Image transcriptions are deleted outright rather than archived.
    expect(await readdir(path.join(directory, "deleted-conversations", archives[0]!, "wisp-config"))).not.toContain(
      "transcription-cache",
    );
  });

  it("deletes a Wisp's conversation only with the Wisp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-conversation-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });

    await expect(repository.delete("first")).rejects.toMatchObject({ code: "invalid_request" });

    expect(repository.getChats().first).toMatchObject({ id: "first" });
    expect(repository.readWisps()).toHaveProperty("first");
  });

  it("gives circle members sessions in the shared workspace, and archives those of members who leave", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-circle-sessions-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ atlas: chat("atlas"), nova: chat("nova"), orion: chat("orion") });
    await repository.saveUserProfile({ preferredName: "Ada", aboutYou: "", responsePreferences: "" });
    await repository.create({ ...circle("crew", ["atlas", "nova"]), name: "Crew", description: "Launch" });

    const context = repository.getCircleAgentContext("crew");
    expect(context).toMatchObject({ kind: "circle", conversationId: "crew", userName: "Ada" });
    expect(context.members.map(({ wispId }) => wispId)).toEqual(["atlas", "nova"]);
    const [atlas, nova] = context.members;
    expect(atlas).toMatchObject({
      conversationId: "crew",
      wispId: "atlas",
      configDirectory: repository.getAgentContext("atlas").configDirectory,
      circle: {
        name: "Crew",
        description: "Launch",
        members: [
          { id: "atlas", name: "atlas", role: "Test" },
          { id: "nova", name: "nova", role: "Test" },
        ],
      },
    });
    // One workspace for the circle, a session folder for each member.
    expect(nova!.workspaceDirectory).toBe(atlas!.workspaceDirectory);
    expect(nova!.workspaceDirectory).not.toBe(repository.getAgentContext("nova").workspaceDirectory);
    expect(nova!.sessionDirectory).not.toBe(atlas!.sessionDirectory);
    await expect(readdir(atlas!.sessionDirectory)).resolves.toEqual([]);
    expect(repository.listCirclesOf("nova")).toEqual(["crew"]);
    expect(repository.listCircleSessionDirectories("nova")).toEqual([nova!.sessionDirectory]);

    await atlas!.savePiSessionIdentity!({ sessionId: "pi-atlas", sessionFile: null });
    expect(repository.getCircleAgentContext("crew").members[0]).toMatchObject({ piSessionId: "pi-atlas" });
    expect(repository.getAgentContext("atlas").piSessionId).toBeNull();

    await writeFile(path.join(nova!.sessionDirectory, "session.jsonl"), "{}\n");
    await repository.update("crew", { kind: "circle", memberIds: ["orion", "atlas"] });

    const updated = repository.getCircleAgentContext("crew");
    expect(updated.members.map(({ wispId }) => wispId)).toEqual(["orion", "atlas"]);
    expect(updated.members[1]!.sessionId).toBe(atlas!.sessionId);
    await expect(readdir(updated.members[0]!.sessionDirectory)).resolves.toEqual([]);
    expect(repository.listCirclesOf("nova")).toEqual([]);
    const [archive] = await readdir(path.join(directory, "deleted-conversations"));
    const archived = path.join(directory, "deleted-conversations", archive!);
    await expect(readFile(path.join(archived, "wisp-session", "session.jsonl"), "utf8")).resolves.toBe("{}\n");
    expect(JSON.parse(await readFile(path.join(archived, "archive.json"), "utf8"))).toMatchObject({
      name: "nova in Crew",
      kind: "circle",
    });
  });

  it("gives members of a circle made before circles had agents a session when it loads", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-circle-missing-sessions-"));
    const first = new ConversationRepository({ dataDirectory: directory });
    await first.initialize({ atlas: chat("atlas"), crew: circle("crew", ["atlas"]) });
    const database = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    database.prepare("DELETE FROM participant_sessions WHERE conversation_id = 'crew'").run();
    database.close();

    const reopened = new ConversationRepository({ dataDirectory: directory });
    await reopened.load();

    const [atlas] = reopened.getCircleAgentContext("crew").members;
    expect(atlas).toMatchObject({ wispId: "atlas" });
    await expect(readdir(atlas!.sessionDirectory)).resolves.toEqual([]);
  });

  it("archives a circle's workspace when it is deleted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-circle-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({ first: chat("first") });
    await repository.create(circle("crew", ["first"]));

    await repository.delete("crew");

    expect(Object.keys(repository.getChats())).toEqual(["first"]);
    const [archive] = await readdir(path.join(directory, "deleted-conversations"));
    // With the session its member had there (ADR 011).
    expect((await readdir(path.join(directory, "deleted-conversations", archive!))).sort()).toEqual([
      "archive.json",
      "wisp-session",
      "workspace",
    ]);
    expect(
      JSON.parse(await readFile(path.join(directory, "deleted-conversations", archive!, "archive.json"), "utf8")),
    ).toMatchObject({ name: "crew", kind: "circle" });
  });

  it("persists member pruning in the same deletion transaction", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-member-delete-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.initialize({
      first: chat("first"),
      second: chat("second"),
      crew: { ...chat("crew", true), memberIds: ["second", "first"] },
    });

    await repository.deleteWisp("first");

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

  it("rejects invalid circle membership as one graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-invalid-graph-"));
    const repository = new ConversationRepository({ dataDirectory: directory });

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
    const wispsBefore = structuredClone(repository.readWisps());
    const { sessionDirectory } = repository.getAgentContext("first");
    // Every write to either table now aborts, as a full disk or I/O error would.
    const saboteur = new DatabaseSync(path.join(directory, "conversations.sqlite"));
    saboteur.exec(`
      CREATE TRIGGER fail_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_conversation_update BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'disk full'); END;
      CREATE TRIGGER fail_wisp_update BEFORE UPDATE ON wisps BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    saboteur.close();

    await expect(
      repository.appendMessage("first", { id: "reply", type: "incoming", text: "Not saved" }),
    ).rejects.toBeDefined();
    await expect(
      repository.setModelOverride("first", { providerId: "anthropic", modelId: "claude-sonnet-5" }),
    ).rejects.toBeDefined();
    await expect(repository.setFallback("first", "off")).rejects.toBeDefined();
    await expect(
      repository.savePiSessionIdentity("first", {
        sessionId: "pi-new",
        sessionFile: path.join(sessionDirectory, "history.jsonl"),
      }),
    ).rejects.toBeDefined();
    await expect(repository.updateWisp("first", { name: "Renamed" })).rejects.toBeDefined();
    await expect(repository.update("first", { kind: "wisp", unread: true })).rejects.toBeDefined();

    expect(repository.list()).toEqual(before);
    expect(repository.readWisps()).toEqual(wispsBefore);
    expect(repository.getAgentContext("first").modelOverride).toBeNull();
    expect(repository.getAgentContext("first").fallback).toBeNull();
    // Nothing partial reached the disk either.
    const restored = await reload(directory);
    expect(restored.list()).toEqual(before);
    expect(restored.readWisps()).toEqual(wispsBefore);
  });

  it("restores every kind of change after a restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-round-trip-"));
    const repository = new ConversationRepository({ dataDirectory: directory });
    await repository.load();
    await repository.initialize({ first: chat("first"), second: chat("second") });
    await repository.create(circle("circle", ["first", "second"]));
    await repository.appendMessage("first", { id: "reply", type: "incoming", text: "Streaming", status: "streaming" });
    await repository.appendMessage("first", { id: "reply", type: "incoming", text: "Done", status: "complete" });
    await repository.appendMessage("first", {
      id: "question",
      type: "prompt",
      question: "Proceed?",
      options: [{ key: "yes", label: "Yes" }],
    });
    await repository.answerPrompt("first", "question", "yes");
    await repository.updateWisp("first", { name: "Renamed" });
    await repository.update("first", { kind: "wisp", unread: true });
    await repository.markRead("first");
    await repository.setModelOverride("first", { providerId: "openrouter", modelId: "openai/gpt-oss-120b" });
    await repository.setFallback("first", { providerId: "anthropic", modelId: "claude-sonnet-5" });
    const { sessionDirectory } = repository.getAgentContext("first");
    await repository.savePiSessionIdentity("first", {
      sessionId: "pi-first",
      sessionFile: path.join(sessionDirectory, "history.jsonl"),
    });
    await repository.deleteWisp("second");
    await repository.close();

    const restarted = await reload(directory);

    expect(restarted.list()).toEqual(repository.list());
    expect(restarted.readWisps()).toEqual(repository.readWisps());
    expect(restarted.readWisps().first?.name).toBe("Renamed");
    expect(restarted.getAgentContext("first").modelOverride).toEqual({
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b",
    });
    expect(restarted.getAgentContext("first").fallback).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
    });
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

  it("preserves a database that is not a database and starts fresh", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-corrupt-db-"));
    await writeFile(path.join(directory, "conversations.sqlite"), "definitely not sqlite", "utf8");
    const repository = new ConversationRepository({ dataDirectory: directory });

    await repository.load();

    expect(repository.didRecoverCorruptState()).toBe(true);
    expect(repository.isInitialized()).toBe(false);
    expect((await readdir(directory)).some((name) => name.startsWith("conversations.sqlite.corrupt-"))).toBe(true);
    await repository.initialize({ first: chat("first") });
    expect(Object.keys((await reload(directory)).getChats())).toEqual(["first"]);
  });

  it("refuses a database from a newer app version and leaves it in place", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-newer-db-"));
    const file = path.join(directory, "conversations.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
    db.exec("INSERT INTO meta VALUES ('store_version', '99')");
    db.close();
    const repository = new ConversationRepository({ dataDirectory: directory });

    await expect(repository.load()).rejects.toThrow("saved by a newer version of Wisp Bot");

    expect(repository.didRecoverCorruptState()).toBe(false);
    expect((await readdir(directory)).filter((name) => name.startsWith("conversations.sqlite"))).toEqual([
      "conversations.sqlite",
    ]);
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
