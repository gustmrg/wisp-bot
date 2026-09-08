import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { ConversationStorage } from "../../backend/conversation-repository.js";
import type { ConversationAgentContext } from "../../backend/conversation-agent.js";
import { normalizeSelection } from "../../backend/ai-settings-store.js";
import {
  normalizeChat,
  normalizeChatCollection,
  normalizeConversationId,
  normalizeMessage,
  validateConversationGraph,
} from "../../backend/conversation-normalizer.js";
import {
  applyWorkspaceAction,
  type ConversationRecord,
  type WorkspaceAction,
  type WorkspaceRecords,
} from "../../backend/workspace-actions.js";
import type { ChatChanges, ChatCollection, Message } from "../../shared/conversations.js";
import type { ModelSelection } from "../../shared/contracts.js";
import { HttpError } from "../errors.js";
import type { ServerDatabase } from "./database.js";

export class SqliteConversationRepository implements ConversationStorage {
  constructor(
    readonly database: ServerDatabase,
    private readonly userName: string,
  ) {}

  async load(): Promise<void> {
    for (const record of this.records()) this.ensureDirectories(record);
  }
  isInitialized(): boolean {
    return this.database.getMeta("initialized") === "true";
  }
  didRecoverCorruptState(): boolean {
    return false;
  }
  list(): ReadonlyArray<ConversationRecord> {
    return this.records().map((record) => ({
      ...record,
      chat: { ...record.chat, messages: this.messages(record.chat.id).messages },
    }));
  }
  getChats(): ChatCollection {
    // Connection snapshots carry bounded previews. The selected conversation loads
    // its full latest page through messages(), and older history uses its cursor.
    let remaining = 2 * 1024 * 1024;
    return Object.fromEntries(
      this.records().map(({ chat }) => {
        const selected: Message[] = [];
        if (remaining > 0)
          for (const message of this.messages(chat.id, undefined, 20).messages.reverse()) {
            const bytes = Buffer.byteLength(JSON.stringify(message));
            if (bytes > remaining) break;
            selected.unshift(message);
            remaining -= bytes;
          }
        return [chat.id, { ...chat, messages: selected, revision: this.revision(chat.id) }];
      }),
    );
  }
  listAgentContexts(): ReadonlyArray<ConversationAgentContext> {
    return this.records()
      .filter((record) => record.sessionId)
      .map((record) => this.context(record));
  }
  getAgentContext(id: string): ConversationAgentContext {
    return this.context(this.require(id));
  }
  getPiSessionContext(id: string): {
    sessionId: string;
    piSessionId: string | null;
    piSessionFile: string | null;
    workspaceDirectory: string;
  } | null {
    const record = this.require(id);
    if (!record.sessionId) return null;
    return {
      sessionId: record.sessionId,
      piSessionId: record.piSessionId,
      piSessionFile: record.piSessionFile,
      workspaceDirectory: path.join(this.database.directory, "workspaces", record.sessionId),
    };
  }

  messages(id: string, before?: string, limit = 200): { messages: Message[]; nextCursor: string | null } {
    this.require(id);
    if (!Number.isInteger(limit) || limit < 1)
      throw new HttpError(400, "invalid_request", "The message limit is invalid.");
    const countLimit = Math.min(limit, 200);
    const byteLimit = 2 * 1024 * 1024;
    const rows: Array<{ ordinal: string; message: string }> = [];
    let bytes = 0;
    let more = false;
    const iterator = this.database.sql
      .prepare(
        "SELECT CAST(ordinal AS TEXT) AS ordinal,message FROM messages WHERE conversation_id=? AND ordinal<? ORDER BY messages.ordinal DESC LIMIT ?",
      )
      .iterate(id, before ? BigInt(before) : 9223372036854775807n, countLimit + 1);
    for (const row of iterator) {
      const message = row.message as string;
      const messageBytes = Buffer.byteLength(message, "utf8") + 1;
      // Always include one complete message. Never consume the first excluded
      // record: the cursor remains at the oldest included row, so it is fetched
      // on the next page even when the byte budget (rather than count) is reached.
      if (rows.length === countLimit || (rows.length > 0 && bytes + messageBytes > byteLimit)) {
        more = true;
        break;
      }
      rows.push({ ordinal: row.ordinal as string, message });
      bytes += messageBytes;
    }
    rows.reverse();
    return {
      messages: rows.map((row) => JSON.parse(row.message) as Message),
      nextCursor: more ? rows[0]!.ordinal : null,
    };
  }

  revision(id: string): number {
    const row = this.database.sql.prepare("SELECT revision FROM conversations WHERE id=?").get(id);
    if (!row) throw new HttpError(404, "not_found", "The conversation was not found.");
    return Number(row.revision);
  }
  revisions(): Record<string, number> {
    return Object.fromEntries(
      this.database.sql
        .prepare("SELECT id,revision FROM conversations")
        .all()
        .map((row) => [row.id, Number(row.revision)]),
    );
  }
  expectRevision(id: string, revision: unknown): void {
    if (!Number.isSafeInteger(revision) || revision !== this.revision(id))
      throw new HttpError(409, "conflict", "The conversation changed. Reload it before editing.");
  }
  touch(id: string): number {
    this.database.sql.prepare("UPDATE conversations SET revision=revision+1 WHERE id=?").run(id);
    return this.revision(id);
  }

  async initialize(chats: unknown): Promise<void> {
    if (this.isInitialized()) return;
    const normalized = normalizeChatCollection(chats);
    this.database.transaction(() => {
      for (const chat of Object.values(normalized)) this.insert(chat);
      this.database.setMeta("initialized", "true");
      this.database.appendEvent("state_changed", {});
    });
  }
  async create(value: unknown): Promise<void> {
    this.database.transaction(() => this.insert(normalizeChat(value)));
  }
  async update(id: string, changes: ChatChanges): Promise<void> {
    this.database.transaction(() =>
      this.action({ type: "update", conversationId: id, changes, updatedAt: new Date().toISOString() }),
    );
  }
  async appendMessage(id: string, value: Message): Promise<void> {
    this.database.transaction(() => this.appendMessageSync(id, value));
  }
  appendMessageSync(id: string, value: Message): void {
    const record = this.require(id);
    const message = normalizeMessage({ ...value, id: value.id ?? randomUUID() }, undefined, 500_000);
    this.database.sql
      .prepare(
        "INSERT INTO messages(conversation_id,id,message) VALUES (?,?,?) ON CONFLICT(conversation_id,id) DO UPDATE SET message=excluded.message",
      )
      .run(id, message.id!, JSON.stringify(message));
    record.chat.preview = "text" in message ? message.text.slice(0, 1000) : record.chat.preview;
    record.chat.timestamp = "Now";
    record.updatedAt = new Date().toISOString();
    this.save(record);
    this.database.appendEvent(
      "state_changed",
      { conversationId: id },
      { conversationId: id, revision: this.revision(id) },
    );
  }
  async answerPrompt(id: string, messageId: string, answer: string): Promise<void> {
    this.database.transaction(() => {
      const row = this.database.sql
        .prepare("SELECT message FROM messages WHERE conversation_id=? AND id=?")
        .get(id, messageId);
      const message = row ? (JSON.parse(row.message as string) as Message) : null;
      if (message?.type !== "prompt") throw new HttpError(404, "not_found", "The prompt is no longer available.");
      this.appendMessageSync(id, { ...message, answer });
    });
  }
  async markRead(id: string): Promise<void> {
    this.database.transaction(() =>
      this.action({ type: "mark-read", conversationId: id, updatedAt: new Date().toISOString() }),
    );
  }
  async setModelOverride(id: string, model: ModelSelection | null): Promise<void> {
    this.database.transaction(() => {
      const record = this.require(id);
      this.context(record);
      const normalized = normalizeSelection(model);
      if (model && !normalized) throw new HttpError(400, "invalid_request", "The model selection is invalid.");
      record.modelOverride = normalized;
      this.save(record);
      this.database.appendEvent(
        "state_changed",
        { conversationId: id },
        { conversationId: id, revision: this.revision(id) },
      );
    });
  }
  async savePiSessionIdentity(id: string, identity: { sessionId: string; sessionFile: string | null }): Promise<void> {
    this.database.transaction(() => {
      const record = this.require(id);
      const context = this.context(record);
      if (identity.sessionFile) {
        const relative = path.relative(context.sessionDirectory, path.resolve(identity.sessionFile));
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new HttpError(400, "invalid_request", "The Pi session path is invalid.");
      }
      record.piSessionId = normalizeConversationId(identity.sessionId);
      record.piSessionFile = identity.sessionFile;
      this.save(record);
    });
  }
  async delete(id: string): Promise<ConversationRecord> {
    const deleted = this.database.transaction(
      () => this.action({ type: "delete", conversationId: id, updatedAt: new Date().toISOString() }).deletedRecord!,
    );
    if (deleted.sessionId) {
      for (const name of ["workspaces", "pi-sessions", "pi-config"]) {
        const archive = path.join(this.database.directory, "deleted-conversations", deleted.sessionId);
        mkdirSync(archive, { recursive: true, mode: 0o700 });
        try {
          renameSync(path.join(this.database.directory, name, deleted.sessionId), path.join(archive, name));
        } catch {
          /* State deletion is authoritative; retain orphan files for admin recovery. */
        }
      }
    }
    return deleted;
  }

  /** Administrative import only, called with a verified, remapped record in maintenance. */
  importRecord(record: ConversationRecord): void {
    this.database.transaction(() => {
      const metadata = { ...record, chat: { ...record.chat, messages: [] } };
      this.insert(metadata.chat, metadata);
      // Archive validation bounds the complete history by bytes. Insert individually
      // without reapplying the desktop JSON-store message-count limit.
      for (const message of record.chat.messages) this.appendMessageSync(record.chat.id, message);
      // Preserve archived preview/timestamps; replaying history is not a new edit.
      this.database.sql
        .prepare("UPDATE conversations SET record=? WHERE id=?")
        .run(JSON.stringify(metadata), record.chat.id);
      this.database.setMeta("initialized", "true");
    });
  }

  private insert(value: unknown, imported?: ConversationRecord): void {
    const chat = normalizeChat(value);
    if (this.database.sql.prepare("SELECT 1 FROM conversations WHERE id=?").get(chat.id))
      throw new HttpError(409, "already_exists", "A conversation with this ID already exists.");
    if (this.records().length >= 1000)
      throw new HttpError(429, "capacity_exceeded", "This instance reached its conversation limit.");
    const timestamp = new Date().toISOString();
    const record: ConversationRecord = imported ?? {
      chat,
      sessionId: chat.kind === "circle" ? null : randomUUID(),
      piSessionId: null,
      piSessionFile: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const metadata = { ...record, chat: { ...chat, messages: [] } };
    const chats = { ...this.metadataChats(), [chat.id]: metadata.chat };
    validateConversationGraph(chats);
    this.ensureDirectories(record);
    const serialized = JSON.stringify(metadata);
    const existingBytes = Number(
      this.database.sql
        .prepare("SELECT COALESCE(SUM(length(CAST(record AS BLOB))),0) AS bytes FROM conversations")
        .get()?.bytes ?? 0,
    );
    if (existingBytes + Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new HttpError(429, "capacity_exceeded", "Conversation metadata exceeds the instance limit.");
    this.database.sql.prepare("INSERT INTO conversations(id,record,revision) VALUES (?,?,1)").run(chat.id, serialized);
    for (const message of chat.messages) this.appendMessageSync(chat.id, message);
    this.database.setMeta("initialized", "true");
    this.database.appendEvent(
      "state_changed",
      { conversationId: chat.id },
      { conversationId: chat.id, revision: this.revision(chat.id) },
    );
  }
  private records(): ConversationRecord[] {
    return this.database.sql
      .prepare("SELECT record FROM conversations ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.record as string) as ConversationRecord);
  }
  private metadataChats(): ChatCollection {
    return Object.fromEntries(this.records().map(({ chat }) => [chat.id, chat]));
  }
  private require(id: string): ConversationRecord {
    const row = this.database.sql.prepare("SELECT record FROM conversations WHERE id=?").get(id);
    if (!row) throw new HttpError(404, "not_found", "The conversation was not found.");
    return JSON.parse(row.record as string) as ConversationRecord;
  }
  private save(record: ConversationRecord): void {
    this.database.sql
      .prepare("UPDATE conversations SET record=?,revision=revision+1 WHERE id=?")
      .run(JSON.stringify({ ...record, chat: { ...record.chat, messages: [] } }), record.chat.id);
  }
  private action(action: WorkspaceAction): ReturnType<typeof applyWorkspaceAction> {
    const records: WorkspaceRecords = Object.fromEntries(this.records().map((record) => [record.chat.id, record]));
    const result = applyWorkspaceAction(records, action);
    if (!["applied", "unchanged"].includes(result.status))
      throw new HttpError(
        result.status === "not_found" ? 404 : 409,
        result.status === "not_found" ? "not_found" : "conflict",
        "The conversation change could not be applied.",
      );
    validateConversationGraph(Object.fromEntries(Object.values(result.records).map(({ chat }) => [chat.id, chat])));
    for (const [id, record] of Object.entries(result.records)) if (record !== records[id]) this.save(record);
    if (result.deletedRecord)
      this.database.sql.prepare("DELETE FROM conversations WHERE id=?").run(result.deletedRecord.chat.id);
    this.database.appendEvent("state_changed", {});
    return result;
  }
  private context(record: ConversationRecord): ConversationAgentContext {
    if (!record.sessionId) throw new HttpError(400, "invalid_request", "Circles do not own agent sessions.");
    return {
      conversationId: record.chat.id,
      sessionId: record.sessionId,
      modelOverride: record.modelOverride ?? null,
      name: record.chat.name,
      label: record.chat.label,
      description: record.chat.description,
      userName: this.userName,
      workspaceDirectory: path.join(this.database.directory, "workspaces", record.sessionId),
      sessionDirectory: path.join(this.database.directory, "pi-sessions", record.sessionId),
      configDirectory: path.join(this.database.directory, "pi-config", record.sessionId),
      piSessionId: record.piSessionId,
      piSessionFile: record.piSessionFile,
      savePiSessionIdentity: (identity) => this.savePiSessionIdentity(record.chat.id, identity),
    };
  }
  private ensureDirectories(record: ConversationRecord): void {
    if (record.sessionId)
      for (const name of ["workspaces", "pi-sessions", "pi-config"])
        mkdirSync(path.join(this.database.directory, name, record.sessionId), { recursive: true, mode: 0o700 });
  }
}
