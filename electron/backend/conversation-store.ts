import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { Message } from "../../shared/conversations.js";
import type { ConversationRecord } from "./workspace-actions.js";

// Bumped only when the table layout changes; record contents are versioned and
// validated separately by the repository.
const STORE_VERSION = "1";

/** Raw persisted state, validated by the repository before use. */
export interface StoredConversationState {
  initialized: boolean;
  conversations: Record<string, unknown>;
}

/**
 * SQLite persistence for conversations: one row per conversation and one row
 * per message, so a change writes only the rows it touches instead of the whole
 * store. Rowids preserve insertion order for both conversations and messages,
 * and upserts keep a row's position. All writes run inside `transaction`.
 */
export class ConversationStore {
  private readonly putConversationStatement: StatementSync;
  private readonly putMessageStatement: StatementSync;
  private readonly deleteOldestMessagesStatement: StatementSync;
  private readonly deleteConversationStatement: StatementSync;
  private readonly setMetaStatement: StatementSync;
  private readonly getMetaStatement: StatementSync;

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
    this.getMetaStatement = db.prepare("SELECT value FROM meta WHERE key = ?");
  }

  /** Opens or creates the database. Throws if the file is not a usable SQLite database. */
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
      `);
      return new ConversationStore(db);
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
    // A newer app version may have changed the layout; never guess at it.
    if (this.getMeta("store_version") !== STORE_VERSION) throw new Error("Unsupported conversation store version.");
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

  /** Runs `write` atomically; any exception rolls back every statement in it. */
  transaction(write: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setMetaStatement.run("store_version", STORE_VERSION);
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

  setInitialized(initialized: boolean): void {
    this.setMetaStatement.run("initialized", initialized ? "1" : "0");
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private getMeta(key: string): string | undefined {
    const row = this.getMetaStatement.get(key);
    return row ? String(row.value) : undefined;
  }
}
