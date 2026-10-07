import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { Message } from "../shared/conversations.js";
import type { ConversationRecord } from "./workspace-actions.js";

// The layout this build writes, and the oldest layout reader that can still
// read and write a database it produced. Additive changes (new tables, indexes,
// or triggers that older writers keep consistent) raise only STORE_VERSION, so
// a downgrade keeps working. Record contents are validated by the repository.
const STORE_VERSION = 3;
const MIN_READER_VERSION = 1;

export const MESSAGE_PAGE_SIZE = 50;
/** Messages on each side of the target in an "around" page. */
export const MESSAGE_PAGE_RADIUS = 25;

/**
 * The searchable text of a message body, derived in SQL so the index stays
 * consistent whichever build writes the row. Must match `messageSearchFragments`
 * in `shared/message-search.ts`; a test checks every message type.
 */
function searchTextOf(body: string): string {
  return `COALESCE(CASE json_extract(${body}, '$.type')
    WHEN 'incoming' THEN json_extract(${body}, '$.text')
    WHEN 'outgoing' THEN json_extract(${body}, '$.text')
    WHEN 'card' THEN (
      SELECT group_concat(json_extract(value, '$.label') || ' — ' || json_extract(value, '$.text'), ' ')
      FROM json_each(${body}, '$.items'))
    WHEN 'prompt' THEN concat_ws(' ',
      json_extract(${body}, '$.question'),
      (SELECT group_concat(json_extract(value, '$.key') || ' ' || json_extract(value, '$.label'), ' ')
        FROM json_each(${body}, '$.options')),
      json_extract(${body}, '$.answer'))
  END, '')`;
}

// Trigram tokens give substring matching, case- and accent-insensitively, for
// queries of 3 or more characters. The table is contentless (the text already
// lives in the message rows) and keyed by the message row's seq.
const SEARCH_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
    text, content = '', contentless_delete = 1, tokenize = 'trigram remove_diacritics 1'
  );
  CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN
    INSERT INTO message_search (rowid, text) VALUES (new.seq, ${searchTextOf("new.body")});
  END;
  CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE OF body ON messages BEGIN
    DELETE FROM message_search WHERE rowid = old.seq;
    INSERT INTO message_search (rowid, text) VALUES (new.seq, ${searchTextOf("new.body")});
  END;
  CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
    DELETE FROM message_search WHERE rowid = old.seq;
  END;
`;

// Messages a Wisp is sent later. Deleting a conversation, from any build,
// removes its scheduled messages through the foreign key.
const SCHEDULED_MESSAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    next_run_at TEXT NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS scheduled_messages_by_conversation ON scheduled_messages (conversation_id);
`;

// Messages waiting for their Wisp, in the order they were queued.
const QUEUED_MESSAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS queued_messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS queued_messages_by_conversation ON queued_messages (conversation_id, seq);
`;

// Version 1 had no search index and no stored last activity.
const UPGRADE_FROM_VERSION_1 = `
  INSERT INTO message_search (message_search) VALUES ('delete-all');
  INSERT INTO message_search (rowid, text) SELECT seq, ${searchTextOf("body")} FROM messages;
  UPDATE conversations SET record = json_set(record, '$.chat.lastActivityAt', (
    SELECT json_extract(body, '$.createdAt') FROM messages
    WHERE conversation_id = conversations.id AND json_extract(body, '$.createdAt') IS NOT NULL
    ORDER BY seq DESC LIMIT 1))
  WHERE EXISTS (
    SELECT 1 FROM messages
    WHERE conversation_id = conversations.id AND json_extract(body, '$.createdAt') IS NOT NULL);
  UPDATE conversations SET record = json_set(record, '$.chat.lastActivityAt', json_extract(record, '$.chat.timestamp'))
  WHERE json_extract(record, '$.chat.lastActivityAt') IS NULL
    AND json_extract(record, '$.chat.timestamp') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*';
`;

/** Raw persisted state, validated by the repository before use. */
export interface StoredConversationState {
  initialized: boolean;
  conversations: Record<string, unknown>;
}

export type StoredPageRequest =
  | { page: "latest" }
  | { page: "older"; before: number }
  | { page: "newer"; after: number }
  | { page: "around"; messageId: string };

/** Raw message bodies (oldest first) with row-position cursors. */
export interface StoredMessagePage {
  messages: ReadonlyArray<unknown>;
  olderCursor: number | null;
  newerCursor: number | null;
}

interface MessageRow {
  seq: number;
  body: unknown;
}

/**
 * SQLite persistence for conversations: one row per conversation and one row
 * per message, so a change writes only the rows it touches instead of the whole
 * store. Rowids preserve insertion order for both conversations and messages,
 * and upserts keep a row's position. A full-text index over messages is kept
 * in sync by triggers. All writes run inside `transaction`.
 */
export class ConversationStore {
  private readonly putConversationStatement: StatementSync;
  private readonly putMessageStatement: StatementSync;
  private readonly deleteOldestMessagesStatement: StatementSync;
  private readonly deleteConversationStatement: StatementSync;
  private readonly setMetaStatement: StatementSync;
  private readonly raiseVersionStatement: StatementSync;
  private readonly getMetaStatement: StatementSync;
  private readonly newestStatement: StatementSync;
  private readonly olderStatement: StatementSync;
  private readonly newerStatement: StatementSync;
  private readonly fromStatement: StatementSync;
  private readonly hasOlderStatement: StatementSync;
  private readonly hasNewerStatement: StatementSync;
  private readonly messageStatement: StatementSync;
  private readonly putScheduledStatement: StatementSync;
  private readonly deleteScheduledStatement: StatementSync;
  private readonly putQueuedStatement: StatementSync;
  private readonly deleteQueuedStatement: StatementSync;

  private constructor(private readonly db: DatabaseSync) {
    this.putConversationStatement = db.prepare(
      "INSERT INTO conversations (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
    );
    this.putMessageStatement = db.prepare(
      "INSERT INTO messages (conversation_id, id, body) VALUES (?, ?, ?) ON CONFLICT (conversation_id, id) DO UPDATE SET body = excluded.body",
    );
    this.deleteOldestMessagesStatement = db.prepare(
      "DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT ?)",
    );
    this.deleteConversationStatement = db.prepare("DELETE FROM conversations WHERE id = ?");
    this.setMetaStatement = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    // Version markers only rise: an older build writing here must not lower them.
    this.raiseVersionStatement = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER)",
    );
    this.getMetaStatement = db.prepare("SELECT value FROM meta WHERE key = ?");
    const select = "SELECT seq, body FROM messages WHERE conversation_id = ?";
    this.newestStatement = db.prepare(`${select} ORDER BY seq DESC LIMIT ?`);
    this.olderStatement = db.prepare(`${select} AND seq < ? ORDER BY seq DESC LIMIT ?`);
    this.newerStatement = db.prepare(`${select} AND seq > ? ORDER BY seq ASC LIMIT ?`);
    this.fromStatement = db.prepare(`${select} AND seq >= ? ORDER BY seq ASC LIMIT ?`);
    this.hasOlderStatement = db.prepare(
      "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND seq < ?) AS found",
    );
    this.hasNewerStatement = db.prepare(
      "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ?) AS found",
    );
    this.messageStatement = db.prepare(`${select} AND id = ?`);
    this.putScheduledStatement = db.prepare(
      "INSERT INTO scheduled_messages (id, conversation_id, next_run_at, record) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET next_run_at = excluded.next_run_at, record = excluded.record",
    );
    this.deleteScheduledStatement = db.prepare("DELETE FROM scheduled_messages WHERE id = ?");
    // An edit keeps the message's place in line.
    this.putQueuedStatement = db.prepare(
      "INSERT INTO queued_messages (id, conversation_id, record) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
    );
    this.deleteQueuedStatement = db.prepare("DELETE FROM queued_messages WHERE id = ?");
  }

  /**
   * Opens or creates the database and upgrades an older layout in place.
   * Throws if the file is not a usable SQLite database.
   */
  static open(filePath: string): ConversationStore {
    const db = new DatabaseSync(filePath);
    try {
      // WAL with NORMAL sync survives app crashes without an fsync per commit;
      // a power loss can drop only the most recent commits, never corrupt the file.
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS conversations (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          record TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          body TEXT NOT NULL,
          UNIQUE (conversation_id, id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, seq);
        ${SEARCH_SCHEMA}
        ${SCHEDULED_MESSAGES_SCHEMA}
        ${QUEUED_MESSAGES_SCHEMA}
      `);
      const store = new ConversationStore(db);
      store.upgrade();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * True once a transaction has committed here. Until then the database may be
   * a leftover from an interrupted first run, so the legacy JSON store still
   * wins.
   */
  isEstablished(): boolean {
    return this.getMeta("store_version") !== undefined;
  }

  read(): StoredConversationState {
    // A newer app version may have changed the layout in a way this build
    // cannot read or write safely; never guess at it.
    const minReader = Number(this.getMeta("min_reader_version") ?? this.getMeta("store_version"));
    if (!Number.isInteger(minReader) || minReader > STORE_VERSION) {
      throw new Error("Unsupported conversation store version.");
    }
    const conversations: Record<string, { chat: { messages: unknown[] } }> = {};
    for (const row of this.db.prepare("SELECT id, record FROM conversations ORDER BY seq").iterate()) {
      const record = JSON.parse(String(row.record)) as { chat: Record<string, unknown> };
      conversations[String(row.id)] = { ...record, chat: { ...record.chat, messages: [] } };
    }
    for (const row of this.db.prepare("SELECT conversation_id, body FROM messages ORDER BY seq").iterate()) {
      conversations[String(row.conversation_id)]?.chat.messages.push(JSON.parse(String(row.body)));
    }
    return { initialized: this.getMeta("initialized") === "1", conversations };
  }

  /** One page of a conversation's messages; see `MessagePageRequest`. */
  readPage(conversationId: string, request: StoredPageRequest): StoredMessagePage {
    switch (request.page) {
      case "latest": {
        const rows = this.rows(this.newestStatement, conversationId, MESSAGE_PAGE_SIZE + 1);
        const page = rows.slice(0, MESSAGE_PAGE_SIZE).reverse();
        return this.page(page, rows.length > MESSAGE_PAGE_SIZE, false);
      }
      case "older": {
        const rows = this.rows(this.olderStatement, conversationId, request.before, MESSAGE_PAGE_SIZE + 1);
        const page = rows.slice(0, MESSAGE_PAGE_SIZE).reverse();
        const newestSeq = page.at(-1)?.seq ?? request.before - 1;
        return this.page(page, rows.length > MESSAGE_PAGE_SIZE, this.hasNewer(conversationId, newestSeq), {
          emptyOlder: request.before,
          emptyNewer: newestSeq,
        });
      }
      case "newer": {
        const rows = this.rows(this.newerStatement, conversationId, request.after, MESSAGE_PAGE_SIZE + 1);
        const page = rows.slice(0, MESSAGE_PAGE_SIZE);
        const oldestSeq = page[0]?.seq ?? request.after + 1;
        return this.page(page, this.hasOlder(conversationId, oldestSeq), rows.length > MESSAGE_PAGE_SIZE, {
          emptyOlder: oldestSeq,
          emptyNewer: request.after,
        });
      }
      case "around": {
        const target = this.rows(this.messageStatement, conversationId, request.messageId)[0];
        if (!target) return { messages: [], olderCursor: null, newerCursor: null };
        const before = this.rows(this.olderStatement, conversationId, target.seq, MESSAGE_PAGE_RADIUS + 1);
        const after = this.rows(this.fromStatement, conversationId, target.seq, MESSAGE_PAGE_RADIUS + 2);
        const page = [...before.slice(0, MESSAGE_PAGE_RADIUS).reverse(), ...after.slice(0, MESSAGE_PAGE_RADIUS + 1)];
        return this.page(page, before.length > MESSAGE_PAGE_RADIUS, after.length > MESSAGE_PAGE_RADIUS + 1);
      }
    }
  }

  /** A stored message body by ID, through the (conversation, message ID) index. */
  getMessage(conversationId: string, messageId: string): unknown {
    return this.rows(this.messageStatement, conversationId, messageId)[0]?.body;
  }

  /** The text the search index holds for a message; used to keep SQL and TypeScript in agreement. */
  searchTextFor(message: Message): string {
    // Bound once and referenced by name: Node 22 cannot bind one numbered parameter used many times.
    const row = this.db
      .prepare(`SELECT ${searchTextOf("source.body")} AS text FROM (SELECT ? AS body) AS source`)
      .get(JSON.stringify(message));
    return String(row?.text ?? "");
  }

  /** Runs `write` atomically; any exception rolls back every statement in it. */
  transaction(write: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.raiseVersionStatement.run("store_version", String(STORE_VERSION));
      this.raiseVersionStatement.run("min_reader_version", String(MIN_READER_VERSION));
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceAll(state: { initialized: boolean; conversations: Readonly<Record<string, ConversationRecord>> }): void {
    this.db.exec("DELETE FROM conversations");
    for (const record of Object.values(state.conversations)) {
      this.putConversation(record);
      this.putMessages(record.chat.id, record.chat.messages);
    }
    this.setInitialized(state.initialized);
  }

  /** Writes the conversation's metadata; its messages are stored separately. */
  putConversation(record: ConversationRecord): void {
    const { messages: _messages, ...chat } = record.chat;
    this.putConversationStatement.run(record.chat.id, JSON.stringify({ ...record, chat }));
  }

  putMessages(conversationId: string, messages: ReadonlyArray<Message>): void {
    for (const message of messages) {
      if (!message.id) throw new Error("Stored messages require an ID.");
      this.putMessageStatement.run(conversationId, message.id, JSON.stringify(message));
    }
  }

  deleteOldestMessages(conversationId: string, count: number): void {
    if (count > 0) this.deleteOldestMessagesStatement.run(conversationId, count);
  }

  /** Deletes the conversation and, through the foreign key, all of its messages. */
  deleteConversation(conversationId: string): void {
    this.deleteConversationStatement.run(conversationId);
  }

  /** Raw scheduled message records, soonest first; validated by the repository. */
  readScheduledMessages(): unknown[] {
    return this.db
      .prepare("SELECT record FROM scheduled_messages ORDER BY next_run_at, seq")
      .all()
      .map((row) => JSON.parse(String(row.record)));
  }

  putScheduledMessage(record: { id: string; conversationId: string; nextRunAt: string }): void {
    this.putScheduledStatement.run(record.id, record.conversationId, record.nextRunAt, JSON.stringify(record));
  }

  deleteScheduledMessage(id: string): void {
    this.deleteScheduledStatement.run(id);
  }

  /** Raw queued message records, oldest first; validated by the repository. */
  readQueuedMessages(): unknown[] {
    return this.db
      .prepare("SELECT record FROM queued_messages ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String(row.record)));
  }

  putQueuedMessage(record: { id: string; conversationId: string }): void {
    this.putQueuedStatement.run(record.id, record.conversationId, JSON.stringify(record));
  }

  deleteQueuedMessage(id: string): void {
    this.deleteQueuedStatement.run(id);
  }

  setInitialized(initialized: boolean): void {
    this.setMetaStatement.run("initialized", initialized ? "1" : "0");
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private upgrade(): void {
    const version = Number(this.getMeta("store_version"));
    if (!this.isEstablished() || version >= STORE_VERSION) return;
    // Version 3 added only the scheduled and queued message tables, which `open` creates.
    this.transaction(() => {
      if (version < 2) this.db.exec(UPGRADE_FROM_VERSION_1);
    });
  }

  private rows(statement: StatementSync, ...parameters: Array<string | number>): MessageRow[] {
    return statement.all(...parameters).map((row) => ({ seq: Number(row.seq), body: JSON.parse(String(row.body)) }));
  }

  /**
   * Builds a page with cursors. An empty page still needs cursors that point
   * past where it would have been, so `positions` supplies them.
   */
  private page(
    rows: ReadonlyArray<MessageRow>,
    hasOlder: boolean,
    hasNewer: boolean,
    positions?: { emptyOlder: number; emptyNewer: number },
  ): StoredMessagePage {
    const oldest = rows[0]?.seq ?? positions?.emptyOlder;
    const newest = rows.at(-1)?.seq ?? positions?.emptyNewer;
    return {
      messages: rows.map(({ body }) => body),
      olderCursor: hasOlder && oldest !== undefined ? oldest : null,
      newerCursor: hasNewer && newest !== undefined ? newest : null,
    };
  }

  private hasOlder(conversationId: string, seq: number): boolean {
    return Number(this.hasOlderStatement.get(conversationId, seq)?.found) === 1;
  }

  private hasNewer(conversationId: string, seq: number): boolean {
    return Number(this.hasNewerStatement.get(conversationId, seq)?.found) === 1;
  }

  private getMeta(key: string): string | undefined {
    const row = this.getMetaStatement.get(key);
    return row ? String(row.value) : undefined;
  }
}
