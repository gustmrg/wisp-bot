import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ConversationStore,
  MESSAGE_PAGE_RADIUS,
  MESSAGE_PAGE_SIZE,
  type StoredMessagePage,
} from "../backend/conversation-store.js";
import { IntactDatabaseError } from "../backend/sqlite-backup.js";
import type { ConversationRecord, WispRecord } from "../backend/workspace-actions.js";
import type { Message } from "../shared/conversations.js";
import { messageSearchText } from "../shared/message-search.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

async function databasePath(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "wisp-store-")), "conversations.sqlite");
}

function record(id: string, messages: Message[] = []): ConversationRecord {
  return {
    chat: {
      id,
      kind: "wisp",
      wispId: id,
      notifyOnUpdatesEnabled: true,
      preview: "",
      lastActivityAt: "2026-09-01T00:00:00.000Z",
      messages,
    },
    storageId: `${id}-workspace`,
    sessions: { [id]: { sessionId: `${id}-session`, piSessionId: null, piSessionFile: null } },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function wispRecord(id: string): WispRecord {
  return {
    wisp: { id, name: id, role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
    storageId: `${id}-settings`,
    modelOverride: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function circleRecord(id: string, memberIds: string[]): ConversationRecord {
  return {
    chat: {
      id,
      kind: "circle",
      name: id,
      label: "",
      description: "",
      memberIds,
      notifyOnUpdatesEnabled: false,
      preview: "",
      unread: true,
      unreadCount: 1,
      messages: [],
    },
    storageId: `${id}-workspace`,
    sessions: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function numbered(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}`, type: "incoming", text: `Message ${index}` }));
}

async function storeWith(messageCount: number): Promise<ConversationStore> {
  const store = ConversationStore.open(await databasePath());
  store.transaction(() =>
    store.replaceAll({
      initialized: true,
      wisps: { one: wispRecord("one") },
      conversations: { one: record("one", numbered(messageCount)) },
    }),
  );
  return store;
}

const ids = (page: StoredMessagePage) => page.messages.map((message) => (message as { id: string }).id);

describe("ConversationStore pages", () => {
  it("reads the newest page with a cursor to older messages", async () => {
    const store = await storeWith(120);

    const latest = store.readPage("one", { page: "latest" });

    expect(ids(latest)).toEqual(Array.from({ length: MESSAGE_PAGE_SIZE }, (_, index) => `m${70 + index}`));
    expect(latest.olderCursor).not.toBeNull();
    expect(latest.newerCursor).toBeNull();
  });

  it("walks back to the first message and forward to the newest without gaps or repeats", async () => {
    const store = await storeWith(120);
    const backward: string[] = [];
    let page = store.readPage("one", { page: "latest" });
    backward.unshift(...ids(page));
    while (page.olderCursor !== null) {
      page = store.readPage("one", { page: "older", before: page.olderCursor });
      backward.unshift(...ids(page));
    }
    expect(backward).toEqual(numbered(120).map(({ id }) => id));
    expect(page.olderCursor).toBeNull();

    const forward = [...ids(page)];
    while (page.newerCursor !== null) {
      page = store.readPage("one", { page: "newer", after: page.newerCursor });
      forward.push(...ids(page));
    }
    expect(forward).toEqual(backward);
  });

  it("centers an around page on the target, clipped at either end", async () => {
    const store = await storeWith(120);

    const middle = store.readPage("one", { page: "around", messageId: "m60" });
    expect(ids(middle)).toEqual(
      Array.from({ length: MESSAGE_PAGE_RADIUS * 2 + 1 }, (_, index) => `m${60 - MESSAGE_PAGE_RADIUS + index}`),
    );
    expect(middle.olderCursor).not.toBeNull();
    expect(middle.newerCursor).not.toBeNull();

    const first = store.readPage("one", { page: "around", messageId: "m3" });
    expect(ids(first)[0]).toBe("m0");
    expect(first.olderCursor).toBeNull();

    const last = store.readPage("one", { page: "around", messageId: "m118" });
    expect(ids(last).at(-1)).toBe("m119");
    expect(last.newerCursor).toBeNull();
  });

  it("returns empty pages for empty conversations and missing targets", async () => {
    const store = ConversationStore.open(await databasePath());
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: wispRecord("one") }, conversations: { one: record("one") } }),
    );

    expect(store.readPage("one", { page: "latest" })).toEqual({ messages: [], olderCursor: null, newerCursor: null });
    expect(store.readPage("one", { page: "around", messageId: "missing" }).messages).toEqual([]);
  });

  it("keeps a message's position when it is updated", async () => {
    const store = await storeWith(3);
    store.transaction(() => store.putMessages("one", [{ id: "m0", type: "incoming", text: "Edited" }]));

    expect(ids(store.readPage("one", { page: "latest" }))).toEqual(["m0", "m1", "m2"]);
    expect(store.getMessage("one", "m0")).toMatchObject({ text: "Edited" });
  });
});

describe("ConversationStore search text", () => {
  const messages: Message[] = [
    { type: "incoming", text: "Hello there" },
    { type: "outgoing", text: "Reply" },
    { type: "time", text: "Context summarized" },
    { type: "card", items: [] },
    {
      type: "card",
      items: [
        { label: "Cluster", text: "Kubernetes prod" },
        { label: "Region", text: "São Paulo" },
      ],
    },
    { type: "prompt", question: "Deploy now?", options: [] },
    {
      type: "prompt",
      question: "Deploy now?",
      options: [
        { key: "y", label: "Yes" },
        { key: "n", label: "No" },
      ],
      answer: "y",
    },
  ];

  it.each(messages)("indexes the same text the app searches: $type", async (message) => {
    const store = ConversationStore.open(await databasePath());

    expect(store.searchTextFor(message)).toBe(messageSearchText(message));
  });
});

describe("ConversationStore versions", () => {
  function meta(file: string): Record<string, string> {
    const db = new DatabaseSync(file);
    try {
      return Object.fromEntries(
        db
          .prepare("SELECT key, value FROM meta")
          .all()
          .map((row) => [row.key, row.value]),
      );
    } finally {
      db.close();
    }
  }

  it("upgrades a version 1 store: builds the search index and backfills last activity", async () => {
    const file = await databasePath();
    const v1 = new DatabaseSync(file);
    v1.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE conversations (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (conversation_id, id)) STRICT;
      INSERT INTO meta VALUES ('store_version', '1'), ('initialized', '1');
    `);
    // Version 1 records predate stored last activity and Wisps stored apart.
    const put = (id: string, timestamp: string) => {
      const { messages: _messages, lastActivityAt: _lastActivityAt, ...chat } = { ...record(id).chat, timestamp };
      v1.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)").run(
        id,
        JSON.stringify({ ...record(id), chat }),
      );
    };
    put("talked", "Now");
    put("created", "2026-09-02T00:00:00.000Z");
    put("legacy", "Yesterday");
    const message = v1.prepare("INSERT INTO messages (conversation_id, id, body) VALUES (?, ?, ?)");
    message.run(
      "talked",
      "a",
      JSON.stringify({ id: "a", type: "incoming", text: "Budget orçamento", createdAt: "2026-09-10T10:00:00.000Z" }),
    );
    message.run("talked", "b", JSON.stringify({ id: "b", type: "time", text: "Divider" }));
    v1.close();

    const store = ConversationStore.open(file);
    const chats = store.read().conversations as Record<string, { chat: { lastActivityAt?: string } }>;

    expect(chats.talked?.chat.lastActivityAt).toBe("2026-09-10T10:00:00.000Z");
    expect(chats.created?.chat.lastActivityAt).toBe("2026-09-02T00:00:00.000Z");
    expect(chats.legacy?.chat).not.toHaveProperty("lastActivityAt");
    expect(store.hasJsonRecords()).toBe(true);
    store.close();
    // The records stay JSON until the repository rebuilds the store.
    expect(meta(file)).toMatchObject({ store_version: "2" });
    const db = new DatabaseSync(file, { readOnly: true });
    expect(db.prepare("SELECT rowid FROM message_search WHERE message_search MATCH ?").all('"orcamento"')).toHaveLength(
      1,
    );
    db.close();
  });

  it("gives Wisps stored with a shape by earlier layout 5 builds an appearance", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() => {
      store.putWisp(wispRecord("one"));
      store.putWisp(wispRecord("two"));
      store.putConversation(record("one"));
    });
    store.close();
    // Recreate the layout those builds wrote: one shape column instead of the appearance columns.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE wisps ADD COLUMN shape TEXT NOT NULL DEFAULT 'circle';
      ${["body", "trail", "tone", "eyes", "eye_ink", "finish", "mark"].map((column) => `ALTER TABLE wisps DROP COLUMN ${column};`).join("\n")}
      UPDATE wisps SET shape = 'hexagon' WHERE id = 'two';
    `);
    db.close();

    const upgraded = ConversationStore.open(file);
    const { wisps } = upgraded.read();
    const legacy = { trail: "none", tone: "vivid", eyes: "oval", eyeInk: "auto", finish: "solid", mark: "none" };
    expect(wisps.one).toMatchObject({ wisp: { appearance: { body: "round", ...legacy } } });
    expect(wisps.two).toMatchObject({ wisp: { appearance: { body: "crystal", ...legacy } } });
    upgraded.transaction(() => upgraded.putWisp({ ...wispRecord("three") }));
    upgraded.close();
    const columns = new DatabaseSync(file, { readOnly: true });
    expect(
      columns
        .prepare("SELECT name FROM pragma_table_info('wisps')")
        .all()
        .map(({ name }) => name),
    ).not.toContain("shape");
    columns.close();
  });

  it("drops the pictures version 5 stored for Wisps, and keeps version 5 builds out", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() => store.putWisp(wispRecord("one")));
    store.close();
    // Recreate the layout version 5 wrote: a picture column, and markers that let version 5 write.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE wisps ADD COLUMN avatar_image TEXT;
      UPDATE wisps SET avatar_image = 'data:image/webp;base64,AAAA';
      UPDATE meta SET value = '5' WHERE key IN ('store_version', 'min_reader_version');
    `);
    db.close();

    const upgraded = ConversationStore.open(file);
    expect(upgraded.read().wisps.one).toEqual(wispRecord("one"));
    upgraded.close();
    const columns = new DatabaseSync(file, { readOnly: true });
    expect(
      columns
        .prepare("SELECT name FROM pragma_table_info('wisps')")
        .all()
        .map(({ name }) => name),
    ).not.toContain("avatar_image");
    columns.close();
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });
  });

  it("adds unread counts to a version 6 store, keeping which conversations are unread", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() =>
      store.replaceAll({
        initialized: true,
        wisps: { one: wispRecord("one"), two: wispRecord("two") },
        conversations: {
          one: { ...record("one"), chat: { ...record("one").chat, unread: true } },
          two: { ...record("two"), chat: { ...record("two").chat, unread: false } },
        },
      }),
    );
    store.close();
    // Recreate the layout version 6 wrote: no count column.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE conversations DROP COLUMN unread_count;
      UPDATE meta SET value = '6' WHERE key IN ('store_version', 'min_reader_version');
    `);
    db.close();

    const upgraded = ConversationStore.open(file);
    const { conversations } = upgraded.read();
    expect(conversations.one).toMatchObject({ chat: { unread: true, unreadCount: 1 } });
    expect(conversations.two).toMatchObject({ chat: { unread: false, unreadCount: 0 } });
    upgraded.close();
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });
  });

  it("trusts unread over a count that a version 6 build left behind", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    const counted = { ...record("one"), chat: { ...record("one").chat, unread: true, unreadCount: 4 } };
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: wispRecord("one") }, conversations: { one: counted } }),
    );
    expect(store.read().conversations.one).toMatchObject({ chat: { unread: true, unreadCount: 4 } });
    store.close();
    // A version 6 build marks it read without knowing about the count.
    const db = new DatabaseSync(file);
    db.exec("UPDATE conversations SET unread = 0");
    db.close();

    const reopened = ConversationStore.open(file);
    expect(reopened.read().conversations.one).toMatchObject({ chat: { unread: false, unreadCount: 0 } });
    reopened.close();
  });

  it("adds pinning to a version 7 store, and keeps pins written since", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: wispRecord("one") }, conversations: { one: record("one") } }),
    );
    store.close();
    // Recreate the layout version 7 wrote: no pinned column.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE conversations DROP COLUMN pinned;
      UPDATE meta SET value = '7' WHERE key = 'store_version';
    `);
    db.close();

    const upgraded = ConversationStore.open(file);
    expect(upgraded.read().conversations.one).toEqual(record("one"));
    const pinned = { ...record("one"), chat: { ...record("one").chat, pinned: true } };
    upgraded.transaction(() => upgraded.putConversation(pinned));
    upgraded.close();
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });

    const reopened = ConversationStore.open(file);
    expect(reopened.read().conversations.one).toEqual(pinned);
    reopened.close();
  });

  it("adds thinking levels to a version 8 store, and ignores one an older build leaves behind", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    const own: WispRecord = { ...wispRecord("one"), modelOverride: { providerId: "anthropic", modelId: "claude" } };
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: own }, conversations: { one: record("one") } }),
    );
    store.close();
    // Recreate the layout version 8 wrote: no thinking level column.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE wisps DROP COLUMN model_thinking_level;
      UPDATE meta SET value = '8' WHERE key = 'store_version';
    `);
    db.close();

    const upgraded = ConversationStore.open(file);
    expect(upgraded.read().wisps.one).toEqual(own);
    const thinking: WispRecord = { ...own, modelOverride: { ...own.modelOverride!, thinkingLevel: "high" } };
    upgraded.transaction(() => upgraded.putWisp(thinking));
    upgraded.close();
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });

    const reopened = ConversationStore.open(file);
    expect(reopened.read().wisps.one).toEqual(thinking);
    reopened.close();

    // A version 8 build clearing the model leaves the level it does not know about.
    const older = new DatabaseSync(file);
    older.exec("UPDATE wisps SET model_provider_id = NULL, model_id = NULL");
    older.close();
    const cleared = ConversationStore.open(file);
    expect(cleared.read().wisps.one).toEqual({ ...own, modelOverride: null });
    cleared.close();
  });

  it("stores Wisps and conversations as columns, related by foreign keys", async () => {
    const store = ConversationStore.open(await databasePath());
    const one: WispRecord = {
      ...wispRecord("one"),
      wisp: {
        id: "one",
        name: "One",
        role: "Research",
        soul: "# Soul",
        appearance: DEFAULT_WISP_APPEARANCE,
        color: "#123456",
      },
      modelOverride: { providerId: "anthropic", modelId: "claude-sonnet-5", maxOutputTokens: 4096 },
    };
    const records = {
      wisps: { one, two: wispRecord("two") },
      conversations: {
        one: record("one", numbered(2)),
        two: { ...record("two"), sessions: {} },
        crew: circleRecord("crew", ["two", "one"]),
      },
    };
    store.transaction(() => store.replaceAll({ initialized: true, ...records }));

    const stored = store.read();
    expect(stored.wisps).toEqual(records.wisps);
    expect(stored.conversations).toEqual({
      one: { ...records.conversations.one, chat: { ...records.conversations.one.chat, messages: numbered(2) } },
      two: records.conversations.two,
      crew: records.conversations.crew,
    });

    // A deleted Wisp takes its own conversation and leaves every circle.
    store.transaction(() => store.deleteWisp("one"));
    const after = store.read().conversations as Record<string, { chat: { memberIds?: string[] } }>;
    expect(Object.keys(after)).toEqual(["two", "crew"]);
    expect(after.crew?.chat.memberIds).toEqual(["two"]);
    expect(store.getMessage("one", "m0")).toBeUndefined();
    // A Wisp's own conversation needs its Wisp.
    expect(() => store.transaction(() => store.putConversation(record("ghost")))).toThrow(/FOREIGN KEY/);
    store.close();
  });

  it("rebuilds a store of JSON records as columns", async () => {
    const file = await databasePath();
    const v4 = new DatabaseSync(file);
    v4.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE conversations (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE wisps (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (conversation_id, id)) STRICT;
      INSERT INTO meta VALUES ('store_version', '4'), ('min_reader_version', '4'), ('initialized', '1');
    `);
    const one = wispRecord("one");
    const conversation = record("one");
    v4.prepare("INSERT INTO wisps (id, record) VALUES (?, ?)").run("one", JSON.stringify(one));
    for (const id of ["one", "dropped"]) {
      const { messages: _messages, ...chat } = { ...conversation.chat, id, wispId: id };
      v4.prepare("INSERT INTO conversations (id, record) VALUES (?, ?)").run(
        id,
        JSON.stringify({ ...conversation, chat }),
      );
      v4.prepare("INSERT INTO messages (conversation_id, id, body) VALUES (?, ?, ?)").run(
        id,
        "m0",
        JSON.stringify({ id: "m0", type: "incoming", text: "Kept", authorId: "one" }),
      );
    }
    v4.close();

    const store = ConversationStore.open(file);
    expect(store.hasJsonRecords()).toBe(true);
    expect(store.read().wisps).toEqual({ one });
    // The repository drops a record it cannot keep; its messages go with it.
    store.rebuild({ wisps: { one }, conversations: { one: conversation } }, { scheduled: [], queued: [] });

    expect(store.hasJsonRecords()).toBe(false);
    expect(store.read()).toEqual({
      initialized: true,
      wisps: { one },
      conversations: {
        one: { ...conversation, chat: { ...conversation.chat, messages: [expect.objectContaining({ text: "Kept" })] } },
      },
    });
    store.close();
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });
    const db = new DatabaseSync(file, { readOnly: true });
    expect(db.prepare("SELECT conversation_id, type, author_id FROM messages").all()).toEqual([
      { conversation_id: "one", type: "incoming", author_id: "one" },
    ]);
    db.close();
  });

  it("adds fallback choices to a version 10 store, and keeps the ones written since", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    const own: WispRecord = { ...wispRecord("one"), modelOverride: { providerId: "anthropic", modelId: "claude" } };
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: own }, conversations: { one: record("one") } }),
    );
    store.close();
    // Recreate the layout version 10 wrote: no fallback columns.
    const db = new DatabaseSync(file);
    db.exec(`
      ALTER TABLE wisps DROP COLUMN fallback_mode;
      ALTER TABLE wisps DROP COLUMN fallback_provider_id;
      ALTER TABLE wisps DROP COLUMN fallback_model_id;
      UPDATE meta SET value = '10' WHERE key = 'store_version';
    `);
    db.close();

    const upgraded = ConversationStore.open(file);
    // A Wisp from before has no choice, so it follows its model.
    expect(upgraded.read().wisps.one).toEqual(own);
    const chosen: WispRecord = { ...own, fallback: { providerId: "openrouter", modelId: "backup" } };
    upgraded.transaction(() => upgraded.putWisp(chosen));
    upgraded.close();
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });

    const reopened = ConversationStore.open(file);
    expect(reopened.read().wisps.one).toEqual(chosen);
    reopened.transaction(() => reopened.putWisp({ ...chosen, fallback: "global" }));
    expect(reopened.read().wisps.one).toEqual({ ...chosen, fallback: "global" });
    reopened.transaction(() => reopened.putWisp(own));
    expect(reopened.read().wisps.one).toEqual(own);
    reopened.close();
  });

  it("names a version 11 store's job run files under the new session folder, and refuses older readers", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: wispRecord("one") }, conversations: { one: record("one") } }),
    );
    const job: Job = {
      id: "job-1",
      conversationId: "one",
      title: "Digest",
      instructions: "Summarize.",
      skills: [],
      tools: [],
      schedule: { kind: "once", at: "2026-10-01T09:00:00.000Z" },
      timeZone: "UTC",
      state: "",
      runCount: 0,
      consecutiveFailures: 0,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    };
    const run = (id: string, sessionFile?: string): JobRun => ({
      id,
      jobId: job.id,
      conversationId: "one",
      trigger: "schedule",
      scheduledAt: job.createdAt,
      startedAt: job.createdAt,
      ...(sessionFile ? { sessionFile } : {}),
    });
    store.transaction(() => {
      store.putJob(job);
      store.putJobRun(run("old", "/data/pi-sessions/session-1/jobs/job-1/old.jsonl"), 10);
      store.putJobRun(run("windows", "C:\\data\\pi-sessions\\session-1\\jobs\\job-1\\windows.jsonl"), 10);
      store.putJobRun(run("none"), 10);
    });
    store.close();
    // The version 11 build named the folder after Pi and did not raise the reader marker.
    const db = new DatabaseSync(file);
    db.exec(
      "UPDATE meta SET value = '11' WHERE key = 'store_version'; UPDATE meta SET value = '6' WHERE key = 'min_reader_version';",
    );
    db.close();

    const upgraded = ConversationStore.open(file);
    const files = Object.fromEntries(
      (upgraded.readJobRuns(job.id, 10) as JobRun[]).map(({ id, sessionFile }) => [id, sessionFile]),
    );
    upgraded.close();
    expect(files).toEqual({
      old: "/data/wisp-sessions/session-1/jobs/job-1/old.jsonl",
      windows: "C:\\data\\wisp-sessions\\session-1\\jobs\\job-1\\windows.jsonl",
      none: undefined,
    });
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });
    expect(meta(`${file}.v11.backup`)).toMatchObject({ store_version: "11" });
    // A reader that predates the new names must not open it and find no sessions.
    const older = new DatabaseSync(file);
    older.exec("UPDATE meta SET value = '14' WHERE key IN ('store_version', 'min_reader_version')");
    older.close();
    expect(() => ConversationStore.open(file)).toThrow("saved by a newer version of Wisp Bot");
  });

  it("names the authors of a version 12 store's replies whose Wisps still exist", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() =>
      store.replaceAll({
        initialized: true,
        wisps: { one: wispRecord("one") },
        conversations: {
          one: record("one", [
            { id: "1", type: "incoming", text: "Mine.", authorId: "one" },
            { id: "2", type: "incoming", text: "Long gone.", authorId: "gone" },
            { id: "3", type: "incoming", text: "Named.", authorId: "one", authorName: "Earlier" },
            { id: "4", type: "outgoing", text: "Hi." },
          ]),
        },
      }),
    );
    store.close();
    const db = new DatabaseSync(file);
    db.exec("UPDATE meta SET value = '12' WHERE key = 'store_version'");
    db.close();

    const upgraded = ConversationStore.open(file);
    const messages = upgraded.read().conversations.one?.chat.messages;
    upgraded.close();
    expect(messages).toEqual([
      { id: "1", type: "incoming", text: "Mine.", authorId: "one", authorName: "one" },
      { id: "2", type: "incoming", text: "Long gone.", authorId: "gone" },
      { id: "3", type: "incoming", text: "Named.", authorId: "one", authorName: "Earlier" },
      { id: "4", type: "outgoing", text: "Hi." },
    ]);
    expect(meta(file)).toMatchObject({ store_version: "13", min_reader_version: "12" });
  });

  it("finishes naming job run files that an interrupted upgrade left under the old folder", async () => {
    const file = await databasePath();
    const store = ConversationStore.open(file);
    store.transaction(() =>
      store.replaceAll({ initialized: true, wisps: { one: wispRecord("one") }, conversations: { one: record("one") } }),
    );
    store.close();
    const db = new DatabaseSync(file);
    db.exec(`
      INSERT INTO jobs (id, conversation_id, title, instructions, skills, tools, schedule, time_zone, state, run_count,
        consecutive_failures, created_at, updated_at)
      VALUES ('job-1', 'one', 'Digest', 'Summarize.', '[]', '[]', '{"kind":"once","at":"2026-10-01T09:00:00.000Z"}',
        'UTC', '', 0, 0, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z');
      INSERT INTO job_runs (id, job_id, conversation_id, trigger, scheduled_at, started_at, session_file)
      VALUES ('run-1', 'job-1', 'one', 'schedule', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z',
        '/data/pi-sessions/session-1/jobs/job-1/run-1.jsonl');
    `);
    db.close();

    const reopened = ConversationStore.open(file);
    expect((reopened.readJobRuns("job-1", 10) as JobRun[])[0]?.sessionFile).toBe(
      "/data/wisp-sessions/session-1/jobs/job-1/run-1.jsonl",
    );
    reopened.close();
  });

  it("reads a newer store that older readers may still use, and refuses one they may not", async () => {
    const readable = await databasePath();
    const store = ConversationStore.open(readable);
    store.transaction(() => store.setInitialized(true));
    store.close();
    const raise = (file: string, storeVersion: string, minReader: string) => {
      const db = new DatabaseSync(file);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'store_version'").run(storeVersion);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'min_reader_version'").run(minReader);
      db.close();
    };

    raise(readable, "14", "12");
    const newer = ConversationStore.open(readable);
    expect(newer.read().initialized).toBe(true);
    // Writing here must not lower the markers the newer build set.
    newer.transaction(() => newer.setInitialized(true));
    newer.close();
    expect(meta(readable)).toMatchObject({ store_version: "14", min_reader_version: "12" });

    raise(readable, "15", "14");
    expect(() => ConversationStore.open(readable)).toThrow(IntactDatabaseError);
    expect(() => ConversationStore.open(readable)).toThrow("saved by a newer version of Wisp Bot");
    // Refusing leaves the newer build's layout exactly as it was.
    expect(meta(readable)).toMatchObject({ store_version: "15", min_reader_version: "14" });
  });

  it("backs up a store before upgrading it, keeping the newest few backups", async () => {
    const file = await databasePath();
    const created = ConversationStore.open(file);
    created.transaction(() => created.setInitialized(true));
    created.close();
    const directory = path.dirname(file);
    const backups = async () => (await readdir(directory)).filter((name) => name.endsWith(".backup")).sort();
    // A store this build created, or already upgraded, needs no backup.
    ConversationStore.open(file).close();
    expect(await backups()).toEqual([]);

    for (const version of [1, 2, 3]) await writeFile(`${file}.v${version}.backup`, "");
    const db = new DatabaseSync(file);
    db.exec("UPDATE meta SET value = '9' WHERE key = 'store_version'");
    db.close();
    const upgraded = ConversationStore.open(file);
    upgraded.transaction(() => upgraded.setInitialized(true));
    upgraded.close();

    expect(await backups()).toEqual([
      "conversations.sqlite.v2.backup",
      "conversations.sqlite.v3.backup",
      "conversations.sqlite.v9.backup",
    ]);
    expect(meta(`${file}.v9.backup`)).toMatchObject({ store_version: "9", initialized: "1" });
    expect(meta(file)).toMatchObject({ store_version: "13" });
  });
});
