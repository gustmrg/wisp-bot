import { mkdtemp, readdir } from "node:fs/promises";
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

    raise(readable, "16", "12");
    const newer = ConversationStore.open(readable);
    expect(newer.read().initialized).toBe(true);
    // Writing here must not lower the markers the newer build set.
    newer.transaction(() => newer.setInitialized(true));
    newer.close();
    expect(meta(readable)).toMatchObject({ store_version: "16", min_reader_version: "12" });

    raise(readable, "17", "16");
    expect(() => ConversationStore.open(readable)).toThrow(IntactDatabaseError);
    expect(() => ConversationStore.open(readable)).toThrow("saved by a newer version of Wisp Bot");
    // Refusing leaves the newer build's layout exactly as it was.
    expect(meta(readable)).toMatchObject({ store_version: "17", min_reader_version: "16" });
  });

  it("refuses a store older than the oldest release it opens, and leaves it as it was", async () => {
    const file = await databasePath();
    const created = ConversationStore.open(file);
    created.transaction(() => created.setInitialized(true));
    created.close();
    const db = new DatabaseSync(file);
    db.exec("UPDATE meta SET value = '12' WHERE key = 'store_version'");
    db.close();

    expect(() => ConversationStore.open(file)).toThrow(IntactDatabaseError);
    expect(() => ConversationStore.open(file)).toThrow("Open them with v0.25.3 first");
    expect(meta(file)).toMatchObject({ store_version: "12", initialized: "1" });
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".backup"))).toEqual([]);
  });
});
