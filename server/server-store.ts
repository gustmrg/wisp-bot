import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    refresh_hash TEXT NOT NULL UNIQUE,
    refresh_expires_at INTEGER NOT NULL,
    previous_refresh_hash TEXT,
    rotated_at INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS pairing_codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
`;

/**
 * Server-only state that the shared backend does not own: the server identity,
 * paired devices, and pending pairing codes. Conversations stay in the
 * backend's own store, laid out exactly like the desktop's.
 */
export class ServerStore {
  readonly database: DatabaseSync;
  readonly serverId: string;

  constructor(dataDirectory: string) {
    this.database = new DatabaseSync(path.join(dataDirectory, "server.sqlite"));
    try {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
      `);
      this.database.exec(SCHEMA);
      const version = Number(this.getMeta("schemaVersion") ?? SCHEMA_VERSION);
      if (version > SCHEMA_VERSION) {
        throw new Error("This data directory was written by a newer Wisp server.");
      }
      this.setMeta("schemaVersion", String(SCHEMA_VERSION));
      let serverId = this.getMeta("serverId");
      if (!serverId) {
        serverId = randomUUID();
        this.setMeta("serverId", serverId);
      }
      this.serverId = serverId;
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.database
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
