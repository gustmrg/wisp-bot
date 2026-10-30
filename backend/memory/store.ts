import type { DatabaseSync } from "node:sqlite";

import { characterCount, looksLikeSecret, memoryLine } from "./text.js";
import type {
  MemoryEntry,
  MemoryErrorDetails,
  MemoryOperation,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryUsage,
  MemoryWriteContext,
} from "./types.js";

/** Characters each scope may hold in active entries (ADR 029). */
export const MEMORY_LIMITS: Readonly<Record<MemoryScope, number>> = { user: 1500, wisp: 4000 };

const SCOPES: readonly MemoryScope[] = ["user", "wisp"];
const USER_SCOPE: readonly MemoryScope[] = ["user"];

const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('user', 'wisp')),
    wisp_id TEXT,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('owner', 'agent')),
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'removed')),
    replaces TEXT,
    observed_at TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((scope = 'user') = (wisp_id IS NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memory_entries_owner ON memory_entries (scope, wisp_id, status);
`;

// Once a release ships a migration it is never edited: a fix is a new
// migration with a new version, as for the other stores.
const MIGRATIONS: Record<number, string> = { 1: SCHEMA };

/** Rolls back a batch that was only being checked. */
const DRY_RUN = Symbol("dry run");

/** Thrown when an operation cannot apply; nothing in its batch was written. */
export class MemoryError extends Error {
  constructor(readonly details: MemoryErrorDetails) {
    super(details.message);
    this.name = "MemoryError";
  }
}

/** Thrown when the memory tables were written by a newer version, which this one must not touch. */
export class MemoryNewerSchemaError extends Error {
  constructor(readonly version: number) {
    super(`Memory was saved by a newer version (schema ${version}; this one reads up to ${SCHEMA_VERSION}).`);
    this.name = "MemoryNewerSchemaError";
  }
}

export interface MemoryStoreOptions {
  /** Called before the tables are upgraded from `version`, for a backup of the database. */
  beforeUpgrade?: (version: number) => void;
  now?: () => Date;
}

interface EntryRow {
  id: string;
  scope: MemoryScope;
  wisp_id: string | null;
  text: string;
  source: MemorySource;
  status: MemoryStatus;
  replaces: string | null;
  observed_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const ORDER = "ORDER BY scope = 'wisp', CAST(substr(id, 2) AS INTEGER)";
const OWNED = "(scope = 'user' OR wisp_id = ?)";
const UNEXPIRED = "(expires_at IS NULL OR expires_at > ?)";

function entryOf(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope,
    wispId: row.wisp_id,
    text: row.text,
    source: row.source,
    status: row.status,
    replaces: row.replaces,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A person's and their Wisps' memory: one-line entries in tables of their own,
 * in a database the caller opens and passes in (ADR 029). Nothing here knows
 * what a Wisp is beyond its ID.
 */
export class MemoryStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  /** Creates or upgrades the memory tables in `db`. */
  static open(db: DatabaseSync, options: MemoryStoreOptions = {}): MemoryStore {
    const store = new MemoryStore(db, options.now ?? (() => new Date()));
    db.exec("CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    const stored = store.getMeta("schema_version");
    const version = stored === undefined ? 0 : Number(stored);
    if (version > SCHEMA_VERSION) throw new MemoryNewerSchemaError(version);
    if (version < SCHEMA_VERSION) {
      if (version > 0) options.beforeUpgrade?.(version);
      store.transaction(() => {
        for (let next = version + 1; next <= SCHEMA_VERSION; next++) db.exec(MIGRATIONS[next] ?? "");
        store.setMeta("schema_version", String(SCHEMA_VERSION));
      });
    }
    return store;
  }

  /**
   * Every entry a Wisp can see, in every status, `user` first, oldest first.
   * Without a Wisp (`null`), the person's own: the `user` scope alone.
   */
  list(wispId: string | null): MemoryEntry[] {
    return this.rows(`SELECT * FROM memory_entries WHERE ${OWNED} ${ORDER}`, wispId);
  }

  /** The entries a Wisp's prompt holds: active and unexpired, in the order `list` gives. */
  active(wispId: string | null): MemoryEntry[] {
    return this.rows(
      `SELECT * FROM memory_entries WHERE ${OWNED} AND status = 'active' AND ${UNEXPIRED} ${ORDER}`,
      wispId,
      this.now().toISOString(),
    );
  }

  /** How much of each scope's limit a Wisp's memory uses; without a Wisp, only the `user` scope's. */
  usage(wispId: string | null): MemoryUsage[] {
    const entries = this.active(wispId);
    return (wispId === null ? USER_SCOPE : SCOPES).map((scope) => ({
      scope,
      used: used(entries, scope),
      limit: MEMORY_LIMITS[scope],
    }));
  }

  /**
   * Applies a batch in one transaction, in order, and returns the entries it
   * created or changed. Any failure throws a `MemoryError` and writes nothing.
   * A batch may not leave a scope over its limit unless it shrinks it.
   */
  apply(operations: readonly MemoryOperation[], context: MemoryWriteContext): MemoryEntry[] {
    if (operations.length === 0) return [];
    return this.transaction(() => this.applyBatch(operations, context));
  }

  /**
   * Throws the `MemoryError` that `apply` would, and writes nothing either way,
   * so a batch can be checked before someone is asked to approve it.
   */
  check(operations: readonly MemoryOperation[], context: MemoryWriteContext): void {
    if (operations.length === 0) return;
    try {
      this.transaction(() => {
        this.applyBatch(operations, context);
        throw DRY_RUN;
      });
    } catch (error) {
      if (error !== DRY_RUN) throw error;
    }
  }

  private applyBatch(operations: readonly MemoryOperation[], context: MemoryWriteContext): MemoryEntry[] {
    const now = this.now().toISOString();
    const before = this.active(context.wispId);
    const changed: string[] = [];
    operations.forEach((operation, index) => {
      changed.push(this.applyOne(operation, index, context, now));
    });
    const after = this.active(context.wispId);
    for (const scope of SCOPES) {
      const total = used(after, scope);
      const limit = MEMORY_LIMITS[scope];
      if (total > limit && total > used(before, scope)) {
        throw new MemoryError({
          code: "over_limit",
          message: `This would leave ${scope} memory at ${total} of ${limit} characters. Remove or shorten entries to free ${total - limit}.`,
          scope,
          limit,
          excess: total - limit,
          entries: before.filter((entry) => entry.scope === scope),
        });
      }
    }
    return [...new Set(changed)].map((id) => this.find(id, context.wispId)!);
  }

  /** Removes a deleted Wisp's entries; `user` entries stay. */
  deleteWisp(wispId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM memory_entries WHERE scope = 'wisp' AND wisp_id = ?").run(wispId);
    });
  }

  private applyOne(operation: MemoryOperation, index: number, context: MemoryWriteContext, now: string): string {
    const fail = (code: MemoryErrorDetails["code"], message: string): never => {
      throw new MemoryError({ code, message, operation: index });
    };
    const lineOf = (text: string): string => {
      const line = memoryLine(text);
      if ("error" in line) return fail("invalid_text", line.error);
      if (context.source === "agent" && looksLikeSecret(line.text))
        fail("secret", "Memory never keeps passwords, keys, tokens or other credentials.");
      return line.text;
    };
    const existing = (id: string): MemoryEntry =>
      this.find(id, context.wispId) ?? fail("not_found", `No memory entry ${id}.`);
    const unique = (scope: MemoryScope, text: string, except?: string) => {
      const same = this.active(context.wispId).find(
        (entry) => entry.scope === scope && entry.text === text && entry.id !== except,
      );
      if (same) fail("duplicate", `Memory already has this as ${same.id}.`);
    };

    switch (operation.op) {
      case "add": {
        if (operation.scope === "wisp" && context.wispId === null)
          fail("invalid_state", "Only a Wisp has memory of its own; add this in the Wisp's settings.");
        const text = lineOf(operation.text);
        unique(operation.scope, text);
        let expiresAt: string | null = null;
        if (operation.expiresAt) {
          const date = new Date(operation.expiresAt);
          if (Number.isNaN(date.getTime())) fail("invalid_text", `${operation.expiresAt} is not a date.`);
          expiresAt = date.toISOString();
        }
        const wispId = operation.scope === "wisp" ? context.wispId : null;
        return this.insert({
          scope: operation.scope,
          wispId,
          text,
          source: context.source,
          replaces: null,
          expiresAt,
          now,
        });
      }
      case "patch": {
        const entry = existing(operation.id);
        if (entry.status !== "active")
          fail("invalid_state", `Memory entry ${entry.id} is ${entry.status}, not active.`);
        const text = lineOf(operation.text);
        unique(entry.scope, text);
        this.setStatus(entry.id, "superseded", now);
        return this.insert({
          scope: entry.scope,
          wispId: entry.wispId,
          text,
          source: context.source,
          replaces: entry.id,
          expiresAt: entry.expiresAt,
          now,
        });
      }
      case "remove": {
        const entry = existing(operation.id);
        if (entry.status !== "active")
          fail("invalid_state", `Memory entry ${entry.id} is ${entry.status}, not active.`);
        this.setStatus(entry.id, "removed", now);
        return entry.id;
      }
      case "restore": {
        const entry = existing(operation.id);
        if (entry.status === "active") fail("invalid_state", `Memory entry ${entry.id} is already active.`);
        unique(entry.scope, entry.text, entry.id);
        this.setStatus(entry.id, "active", now);
        return entry.id;
      }
    }
  }

  private insert(entry: {
    scope: MemoryScope;
    wispId: string | null;
    text: string;
    source: MemorySource;
    replaces: string | null;
    expiresAt: string | null;
    now: string;
  }): string {
    const next = Number(this.getMeta("next_id") ?? "1");
    const id = `m${next}`;
    this.setMeta("next_id", String(next + 1));
    this.db
      .prepare(
        `INSERT INTO memory_entries
          (id, scope, wisp_id, text, source, status, replaces, observed_at, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.scope,
        entry.wispId,
        entry.text,
        entry.source,
        entry.replaces,
        entry.now,
        entry.expiresAt,
        entry.now,
        entry.now,
      );
    return id;
  }

  private setStatus(id: string, status: MemoryStatus, now: string): void {
    this.db.prepare("UPDATE memory_entries SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  }

  private find(id: string, wispId: string | null): MemoryEntry | undefined {
    return this.rows(`SELECT * FROM memory_entries WHERE id = ? AND ${OWNED}`, id, wispId)[0];
  }

  /** A `null` Wisp ID matches no `wisp_id`, so `OWNED` leaves only the `user` scope. */
  private rows(sql: string, ...parameters: Array<string | null>): MemoryEntry[] {
    return (this.db.prepare(sql).all(...parameters) as unknown as EntryRow[]).map(entryOf);
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Runs `work` atomically; inside a transaction the caller opened, as a savepoint of it. */
  private transaction<T>(work: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT memory" : "BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec(nested ? "RELEASE memory" : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(nested ? "ROLLBACK TO memory; RELEASE memory" : "ROLLBACK");
      throw error;
    }
  }
}

function used(entries: readonly MemoryEntry[], scope: MemoryScope): number {
  return entries
    .filter((entry) => entry.scope === scope)
    .reduce((total, entry) => total + characterCount(entry.text), 0);
}
