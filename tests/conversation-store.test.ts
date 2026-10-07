import { mkdtemp } from "node:fs/promises";
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
import type { ConversationRecord } from "../backend/workspace-actions.js";
import type { Message } from "../shared/conversations.js";
import { messageSearchText } from "../shared/message-search.js";

async function databasePath(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "wisp-store-")), "conversations.sqlite");
}

function record(id: string, messages: Message[] = []): ConversationRecord {
  return {
    chat: {
      id,
      kind: "wisp",
      shape: "circle",
      name: id,
      label: "",
      description: "",
      notifyOnUpdatesEnabled: true,
      preview: "",
      timestamp: "2026-09-01T00:00:00.000Z",
      messages,
    },
    sessionId: `${id}-session`,
    modelOverride: null,
    piSessionId: null,
    piSessionFile: null,
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
    store.replaceAll({ initialized: true, conversations: { one: record("one", numbered(messageCount)) } }),
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
    store.transaction(() => store.replaceAll({ initialized: true, conversations: { one: record("one") } }));

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
    const put = (id: string, timestamp: string) => {
      const { messages: _messages, ...chat } = { ...record(id).chat, timestamp };
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
    store.close();
    expect(meta(file)).toMatchObject({ store_version: "3", min_reader_version: "1" });
    const db = new DatabaseSync(file, { readOnly: true });
    expect(db.prepare("SELECT rowid FROM message_search WHERE message_search MATCH ?").all('"orcamento"')).toHaveLength(
      1,
    );
    db.close();
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

    raise(readable, "4", "3");
    const newer = ConversationStore.open(readable);
    expect(newer.read().initialized).toBe(true);
    // Writing here must not lower the markers the newer build set.
    newer.transaction(() => newer.setInitialized(true));
    newer.close();
    expect(meta(readable)).toMatchObject({ store_version: "4", min_reader_version: "3" });

    raise(readable, "5", "4");
    const incompatible = ConversationStore.open(readable);
    expect(() => incompatible.read()).toThrow("Unsupported conversation store version.");
    incompatible.close();
  });
});
