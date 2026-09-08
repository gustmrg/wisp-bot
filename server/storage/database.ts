import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HttpError } from "../errors.js";

export interface DurableEvent {
  protocolVersion: 1;
  serverId: string;
  bootId: string;
  eventId: string;
  type: string;
  occurredAt: string;
  conversationId?: string;
  requestId?: string;
  revision?: number;
  payload: unknown;
}

/** The event table is also the transactional outbox. Streams read committed rows. */
export class ServerDatabase {
  readonly sql: DatabaseSync;
  readonly serverId: string;
  readonly ownerId: string;
  readonly bootId = randomUUID();
  private generation: string;
  private depth = 0;
  private closed = false;
  private readonly lockPath: string;
  private readonly lockValue: string;
  private readonly instanceLock: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.lockPath = path.join(directory, "server.lock");
    this.lockValue = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    // The authoritative lock belongs to the OS, not a PID namespace. A dedicated
    // rollback-journal database holds an exclusive transaction for this instance's
    // entire lifetime; the kernel releases it even after SIGKILL or PID reuse.
    const guardPath = path.join(directory, "instance-lock.sqlite");
    const guard = new DatabaseSync(guardPath);
    try {
      guard.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      chmodSync(guardPath, 0o600);
    } catch (error) {
      guard.close();
      if ((error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6)
        throw new Error("Another server owns this data directory.");
      throw error;
    }
    this.instanceLock = guard;
    let opened: DatabaseSync | undefined;
    try {
      // This file is diagnostic only. Never use process.kill(pid, 0) as ownership
      // evidence: containers commonly reuse the same PID after a restart.
      const diagnostic = openSync(
        this.lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(diagnostic, this.lockValue);
        fsyncSync(diagnostic);
      } finally {
        closeSync(diagnostic);
      }
      opened = new DatabaseSync(path.join(directory, "wisp.sqlite"));
      this.sql = opened;
      this.sql.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, record TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS messages (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, id TEXT NOT NULL, message TEXT NOT NULL, UNIQUE(conversation_id,id));
        CREATE TABLE IF NOT EXISTS requests (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, error_code TEXT, UNIQUE(conversation_id,id));
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, envelope TEXT NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pairing (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), kind TEXT NOT NULL, expires_at INTEGER NOT NULL, csrf TEXT NOT NULL, used_at INTEGER, replacement TEXT);
        CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL, device_id TEXT, decided_at TEXT);
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS requests_pending ON requests(status,ordinal);
        CREATE INDEX IF NOT EXISTS tokens_device ON tokens(device_id);
        CREATE INDEX IF NOT EXISTS events_time ON events(created_at);
      `);
      const version = this.getMeta("schemaVersion");
      if (version !== null && version !== "1")
        throw new Error("Unsupported server schema; restore a compatible backup.");
      this.setMeta("schemaVersion", "1");
      this.serverId = this.getMeta("serverId") ?? randomUUID();
      this.ownerId = this.getMeta("ownerId") ?? randomUUID();
      this.generation = this.getMeta("generation") ?? randomUUID();
      this.setMeta("serverId", this.serverId);
      this.setMeta("ownerId", this.ownerId);
      this.setMeta("generation", this.generation);
      chmodSync(path.join(directory, "wisp.sqlite"), 0o600);
    } catch (error) {
      try {
        opened?.close();
        this.removeDiagnostic();
      } finally {
        this.instanceLock.close();
      }
      throw error;
    }
  }

  getMeta(key: string): string | null {
    return (this.sql.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value as string | undefined) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql
      .prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  transaction<T>(operation: () => T): T {
    if (this.depth) return operation();
    this.sql.exec("BEGIN IMMEDIATE");
    this.depth++;
    let result: T;
    const previousGeneration = this.generation;
    try {
      result = operation();
      this.sql.exec("COMMIT");
    } catch (error) {
      this.sql.exec("ROLLBACK");
      this.generation = previousGeneration;
      throw error;
    } finally {
      this.depth--;
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A subscriber cannot roll back a committed domain mutation. */
      }
    }
    return result;
  }

  appendEvent(
    type: string,
    payload: unknown,
    fields: Pick<DurableEvent, "conversationId" | "requestId" | "revision"> = {},
  ): DurableEvent {
    if (!this.depth) return this.transaction(() => this.appendEvent(type, payload, fields));
    const base = {
      protocolVersion: 1 as const,
      serverId: this.serverId,
      bootId: this.bootId,
      type,
      occurredAt: new Date().toISOString(),
      ...fields,
      payload,
    };
    const serialized = JSON.stringify(base);
    const result = this.sql
      .prepare("INSERT INTO events(envelope,created_at,bytes) VALUES (?,?,?)")
      .run(serialized, Date.now(), Buffer.byteLength(serialized));
    return { ...base, eventId: `${this.generation}:${result.lastInsertRowid}` };
  }

  cursor(): string {
    const row = this.sql.prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name='events'").get();
    return `${this.generation}:${row?.seq ?? 0}`;
  }

  eventsAfter(cursor: string, limit = 256): DurableEvent[] {
    const [generation, sequence] = cursor.split(":");
    if (generation !== this.generation || !sequence || !/^\d{1,19}$/.test(sequence))
      throw new HttpError(409, "resync_required", "Reload the server snapshot.");
    const after = BigInt(sequence);
    const min = this.sql.prepare("SELECT CAST(MIN(id) AS TEXT) AS id FROM events").get()?.id as string | null;
    const max = BigInt(this.cursor().split(":")[1]!);
    if (after > max || (min && after < BigInt(min) - 1n) || (!min && after < max))
      throw new HttpError(409, "resync_required", "The event cursor expired. Reload the server snapshot.");
    return this.sql
      .prepare("SELECT CAST(id AS TEXT) AS id,envelope FROM events WHERE id>? ORDER BY events.id LIMIT ?")
      .all(after, limit)
      .map(
        (row) => ({ ...JSON.parse(row.envelope as string), eventId: `${this.generation}:${row.id}` }) as DurableEvent,
      );
  }

  retainEvents(now = Date.now(), maxBytes = 64 * 1024 * 1024): void {
    this.transaction(() => {
      this.sql.prepare("DELETE FROM events WHERE created_at<?").run(now - 86_400_000);
      const bytes = Number(this.sql.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM events").get()?.bytes ?? 0);
      if (bytes > maxBytes)
        this.sql
          .prepare(
            "DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id,SUM(bytes) OVER (ORDER BY id DESC) AS retained FROM events) WHERE retained>?)",
          )
          .run(maxBytes);
    });
  }

  onCommit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  invalidateCursors(): void {
    this.generation = randomUUID();
    this.setMeta("generation", this.generation);
  }
  checkpoint(): void {
    this.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sql.close();
      this.removeDiagnostic();
    } finally {
      this.instanceLock.close();
    }
  }

  private removeDiagnostic(): void {
    try {
      if (readFileSync(this.lockPath, "utf8") === this.lockValue) unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
