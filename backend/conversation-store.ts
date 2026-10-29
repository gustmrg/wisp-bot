import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { Message } from "../shared/conversations.js";
import type { Job, JobRun } from "../shared/jobs.js";
import type { QueuedMessage } from "../shared/message-queue.js";
import type { ScheduledMessage } from "../shared/scheduled-messages.js";
import { backUpBeforeUpgrade, IntactDatabaseError } from "./sqlite-backup.js";
import { renamedSessionFile } from "./storage-layout.js";
import type { ConversationRecord, WispRecord, WorkspaceRecords } from "./workspace-actions.js";

// The layout this build writes, and the oldest layout reader that can still
// read and write a database it produced. Additive changes (new tables, indexes,
// or triggers that older writers keep consistent) raise only STORE_VERSION, so
// a downgrade keeps working. Record contents are validated by the repository.
// Prefer additive changes: after one that raises MIN_READER_VERSION, going back
// to an older release means restoring the backup made before the upgrade.
// Beta releases share this database with stable ones, so once a beta ships an
// upgrade it is never edited: a fix is a new upgrade with a new version.
// Version 4 stored Wisps apart from conversations, and version 5 stores records
// as columns instead of JSON; earlier readers understand neither. Version 6
// drops the Wisp picture column, which version 5 writers still name. Version 7
// adds unread counts; older writers keep `unread` right, and reads trust it.
// Version 8 adds pinned conversations; older writers leave the column alone.
// Version 9 adds each Wisp's thinking level; older writers leave it alone too,
// so reads ignore it when the Wisp has no model of its own.
// Version 10 adds jobs and their runs; older writers leave them alone, and
// deleting a conversation removes them through foreign keys.
// Version 11 adds each Wisp's fallback choice; older writers leave it alone,
// and a Wisp they create has none, so it follows its model.
// Version 12 follows the Wisp folders' new names (ADR 027) in each job run's
// session file. Older readers look for the old folder names and would find
// none, so it raises MIN_READER_VERSION: an older build refuses this database.
// Version 13 names each reply's author in the reply itself, so a reply keeps a
// name after its Wisp is deleted. Older readers ignore the field.
// Version 14 adds whether a Wisp runs without memory; older writers leave it
// alone, and a Wisp they create has memory.
const STORE_VERSION = 14;
const MIN_READER_VERSION = 12;
/** The first layout whose job runs name their session files under the runtime-neutral folders. */
const WISP_FOLDERS_VERSION = 12;
/** The first layout whose replies carry their author's name. */
const AUTHOR_NAMES_VERSION = 13;
/** The first layout that stores records as columns rather than JSON. */
const COLUMN_RECORDS_VERSION = 5;

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

// Messages carry their fields in the JSON body, since their shape depends on
// their type. The fields queries may need are derived from it, so they can
// never disagree with the body.
const MESSAGE_COLUMNS = [
  "type TEXT GENERATED ALWAYS AS (json_extract(body, '$.type')) VIRTUAL",
  "created_at TEXT GENERATED ALWAYS AS (json_extract(body, '$.createdAt')) VIRTUAL",
  "author_id TEXT GENERATED ALWAYS AS (json_extract(body, '$.authorId')) VIRTUAL",
];

const MESSAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    body TEXT NOT NULL,
    ${MESSAGE_COLUMNS.join(",\n    ")},
    UNIQUE (conversation_id, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, seq);
`;

// Wisps and conversations, with what relates them as foreign keys: a Wisp's
// own conversation shares its ID and goes with it, and a deleted Wisp leaves
// every circle and session. A Wisp's appearance columns have no CHECK: their
// values are display choices that grow often, and SQLite cannot change a CHECK
// without rebuilding the table. The repository validates them on read.
const RECORD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wisps (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    soul TEXT NOT NULL,
    body TEXT NOT NULL,
    trail TEXT NOT NULL,
    tone TEXT NOT NULL,
    eyes TEXT NOT NULL,
    eye_ink TEXT NOT NULL,
    finish TEXT NOT NULL,
    mark TEXT NOT NULL,
    color TEXT,
    storage_id TEXT NOT NULL,
    model_provider_id TEXT,
    model_id TEXT,
    model_max_output_tokens INTEGER,
    model_thinking_level TEXT,
    fallback_mode TEXT,
    fallback_provider_id TEXT,
    fallback_model_id TEXT,
    memory_off INTEGER NOT NULL DEFAULT 0 CHECK (memory_off IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((model_provider_id IS NULL) = (model_id IS NULL)),
    CHECK (model_max_output_tokens IS NULL OR model_id IS NOT NULL)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS conversations (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('wisp', 'circle')),
    wisp_id TEXT UNIQUE REFERENCES wisps (id) ON DELETE CASCADE,
    name TEXT,
    label TEXT,
    description TEXT,
    notify_on_updates_enabled INTEGER NOT NULL CHECK (notify_on_updates_enabled IN (0, 1)),
    preview TEXT NOT NULL,
    unread INTEGER CHECK (unread IN (0, 1)),
    unread_count INTEGER CHECK (unread_count >= 0),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    last_activity_at TEXT,
    storage_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (CASE kind
      WHEN 'wisp' THEN wisp_id = id AND name IS NULL AND label IS NULL AND description IS NULL
      ELSE wisp_id IS NULL AND name IS NOT NULL AND label IS NOT NULL AND description IS NOT NULL
    END)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS circle_members (
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    wisp_id TEXT NOT NULL REFERENCES wisps (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, wisp_id),
    UNIQUE (conversation_id, position)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS circle_members_by_wisp ON circle_members (wisp_id);
  CREATE TABLE IF NOT EXISTS participant_sessions (
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    wisp_id TEXT NOT NULL REFERENCES wisps (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    pi_session_id TEXT,
    pi_session_file TEXT,
    PRIMARY KEY (conversation_id, wisp_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS participant_sessions_by_wisp ON participant_sessions (wisp_id);
`;

// Messages a Wisp is sent later, and messages waiting for their Wisp in the
// order they were queued. Deleting a conversation removes both. A schedule
// stays JSON: new kinds of schedule join it without changing the table.
const PENDING_MESSAGES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    schedule TEXT NOT NULL CHECK (json_valid(schedule)),
    time_zone TEXT NOT NULL,
    next_run_at TEXT NOT NULL,
    sent_count INTEGER NOT NULL,
    last_sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS scheduled_messages_by_conversation ON scheduled_messages (conversation_id);
  CREATE TABLE IF NOT EXISTS queued_messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    scheduled_message_id TEXT,
    scheduled_at TEXT,
    scheduled_time_zone TEXT,
    CHECK ((scheduled_message_id IS NULL) = (scheduled_at IS NULL)
      AND (scheduled_message_id IS NULL) = (scheduled_time_zone IS NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS queued_messages_by_conversation ON queued_messages (conversation_id, seq);
`;

// Jobs a Wisp runs on a schedule, and a record of each run (ADR 019). Like
// scheduled messages, a job belongs to its Wisp's conversation and goes with
// it. Schedules, lists and small nested records stay JSON.
const JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    skills TEXT NOT NULL CHECK (json_valid(skills)),
    tools TEXT NOT NULL CHECK (json_valid(tools)),
    schedule TEXT NOT NULL CHECK (json_valid(schedule)),
    time_zone TEXT NOT NULL,
    next_run_at TEXT,
    retry TEXT CHECK (retry IS NULL OR json_valid(retry)),
    paused TEXT CHECK (paused IS NULL OR json_valid(paused)),
    state TEXT NOT NULL,
    run_count INTEGER NOT NULL,
    consecutive_failures INTEGER NOT NULL,
    last_run TEXT CHECK (last_run IS NULL OR json_valid(last_run)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS jobs_by_conversation ON jobs (conversation_id);
  CREATE TABLE IF NOT EXISTS job_runs (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT,
    error_code TEXT,
    delivery_error_code TEXT,
    skip_reason TEXT,
    usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
    message_id TEXT,
    session_file TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS job_runs_by_job ON job_runs (job_id, seq);
`;

// Builds of layout 5 made before Wisp appearances stored a single shape. Each
// Wisp keeps the closest body and the flat look it had, with no trail; this
// matches `appearanceFromLegacyShape`.
const UPGRADE_SHAPE_TO_APPEARANCE = `
  ALTER TABLE wisps ADD COLUMN body TEXT NOT NULL DEFAULT 'round';
  ALTER TABLE wisps ADD COLUMN trail TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE wisps ADD COLUMN tone TEXT NOT NULL DEFAULT 'vivid';
  ALTER TABLE wisps ADD COLUMN eyes TEXT NOT NULL DEFAULT 'oval';
  ALTER TABLE wisps ADD COLUMN eye_ink TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE wisps ADD COLUMN finish TEXT NOT NULL DEFAULT 'solid';
  ALTER TABLE wisps ADD COLUMN mark TEXT NOT NULL DEFAULT 'none';
  UPDATE wisps SET body = CASE shape
    WHEN 'pill' THEN 'pebble' WHEN 'pebble' THEN 'pebble' WHEN 'cloud' THEN 'pebble'
    WHEN 'square' THEN 'block'
    WHEN 'triangle' THEN 'crystal' WHEN 'diamond' THEN 'crystal' WHEN 'hexagon' THEN 'crystal'
    WHEN 'drop' THEN 'drop'
    ELSE 'round' END;
  ALTER TABLE wisps DROP COLUMN shape;
`;

// Version 5 stored an uploaded picture for each Wisp. Wisps are only drawn now,
// so the pictures go.
const DROP_WISP_PICTURES = "ALTER TABLE wisps DROP COLUMN avatar_image;";

// Builds before version 7 stored only whether a conversation was unread; reads
// count one unread message for those.
const ADD_UNREAD_COUNTS = "ALTER TABLE conversations ADD COLUMN unread_count INTEGER CHECK (unread_count >= 0);";

// Builds before version 8 could not pin conversations.
const ADD_PINNED_CONVERSATIONS =
  "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));";

// Builds before version 9 could not choose a Wisp's thinking level; its Wisps think "off".
const ADD_WISP_THINKING_LEVELS = "ALTER TABLE wisps ADD COLUMN model_thinking_level TEXT;";

// Builds before version 11 could not choose a Wisp's fallback; its Wisps follow their model.
const ADD_WISP_FALLBACKS = `
  ALTER TABLE wisps ADD COLUMN fallback_mode TEXT;
  ALTER TABLE wisps ADD COLUMN fallback_provider_id TEXT;
  ALTER TABLE wisps ADD COLUMN fallback_model_id TEXT;
`;

// Builds before version 14 could not turn a Wisp's memory off; its Wisps have memory.
const ADD_WISP_MEMORY_OFF =
  "ALTER TABLE wisps ADD COLUMN memory_off INTEGER NOT NULL DEFAULT 0 CHECK (memory_off IN (0, 1));";

// Replies stored before version 13 name their author only by ID; those whose Wisp
// still exists take its name. Replies of Wisps already deleted stay unnamed.
const NAME_MESSAGE_AUTHORS = `
  UPDATE messages
  SET body = json_set(body, '$.authorName', (SELECT name FROM wisps WHERE wisps.id = messages.author_id))
  WHERE author_id IS NOT NULL
    AND json_extract(body, '$.authorName') IS NULL
    AND EXISTS (SELECT 1 FROM wisps WHERE wisps.id = messages.author_id);
`;

/** Tables layout 5 replaced; their rows held whole records as JSON. */
const JSON_RECORD_TABLES = ["wisps", "conversations", "scheduled_messages", "queued_messages"];

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
  wisps: Record<string, unknown>;
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

type Row = Record<string, unknown>;

const optional = (value: unknown) => (value === null || value === undefined ? undefined : value);

/** A stored Wisp row as the record the repository validates. */
function wispRecordOf(row: Row): unknown {
  const color = optional(row.color);
  const maxOutputTokens = optional(row.model_max_output_tokens);
  const thinkingLevel = optional(row.model_thinking_level);
  const fallbackMode = optional(row.fallback_mode);
  return {
    wisp: {
      id: row.id,
      name: row.name,
      role: row.role,
      soul: row.soul,
      appearance: {
        body: row.body,
        trail: row.trail,
        tone: row.tone,
        eyes: row.eyes,
        eyeInk: row.eye_ink,
        finish: row.finish,
        mark: row.mark,
      },
      ...(color === undefined ? {} : { color }),
      ...(row.memory_off === 1 ? { memoryOff: true } : {}),
    },
    storageId: row.storage_id,
    modelOverride:
      row.model_id === null
        ? null
        : {
            providerId: row.model_provider_id,
            modelId: row.model_id,
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: Number(maxOutputTokens) }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          },
    ...(fallbackMode === undefined
      ? {}
      : {
          fallback:
            fallbackMode === "model"
              ? { providerId: row.fallback_provider_id, modelId: row.fallback_model_id }
              : fallbackMode,
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A stored conversation row, without its members and sessions, as the record the repository validates. */
function conversationRecordOf(row: Row): { chat: Row & { messages: unknown[] }; sessions: Row } & Row {
  const lastActivityAt = optional(row.last_activity_at);
  const base = {
    id: row.id,
    kind: row.kind,
    notifyOnUpdatesEnabled: row.notify_on_updates_enabled === 1,
    preview: row.preview,
    messages: [] as unknown[],
    ...unreadOf(row),
    ...(row.pinned === 1 ? { pinned: true } : {}),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  };
  const chat =
    row.kind === "wisp"
      ? { ...base, wispId: row.wisp_id }
      : { ...base, name: row.name, label: row.label, description: row.description, memberIds: [] };
  return { chat, storageId: row.storage_id, sessions: {}, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * `unread` decides whether a conversation has unread messages, since builds
 * before version 7 write it without the count: a count they left behind on a
 * read conversation is stale, and one they marked unread has at least one.
 */
function unreadOf(row: Row): { unread?: boolean; unreadCount?: number } {
  if (row.unread === null) return {};
  if (row.unread !== 1) return { unread: false, unreadCount: 0 };
  return { unread: true, unreadCount: Math.max(1, Number(row.unread_count ?? 1)) };
}

function scheduledMessageOf(row: Row): unknown {
  const lastSentAt = optional(row.last_sent_at);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    schedule: JSON.parse(String(row.schedule)),
    timeZone: row.time_zone,
    nextRunAt: row.next_run_at,
    sentCount: Number(row.sent_count),
    ...(lastSentAt === undefined ? {} : { lastSentAt }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const json = (value: unknown) => (value === null || value === undefined ? undefined : JSON.parse(String(value)));

function jobOf(row: Row): unknown {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    instructions: row.instructions,
    skills: json(row.skills),
    tools: json(row.tools),
    schedule: json(row.schedule),
    timeZone: row.time_zone,
    nextRunAt: optional(row.next_run_at),
    retry: json(row.retry),
    paused: json(row.paused),
    state: row.state,
    runCount: Number(row.run_count),
    consecutiveFailures: Number(row.consecutive_failures),
    lastRun: json(row.last_run),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobRunOf(row: Row): unknown {
  return {
    id: row.id,
    jobId: row.job_id,
    conversationId: row.conversation_id,
    trigger: row.trigger,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    endedAt: optional(row.ended_at),
    status: optional(row.status),
    errorCode: optional(row.error_code),
    deliveryErrorCode: optional(row.delivery_error_code),
    skipReason: optional(row.skip_reason),
    usage: json(row.usage),
    messageId: optional(row.message_id),
    sessionFile: optional(row.session_file),
  };
}

function queuedMessageOf(row: Row): unknown {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    text: row.text,
    createdAt: row.created_at,
    ...(row.scheduled_message_id === null
      ? {}
      : {
          scheduled: {
            scheduledMessageId: row.scheduled_message_id,
            scheduledAt: row.scheduled_at,
            timeZone: row.scheduled_time_zone,
          },
        }),
  };
}

/**
 * SQLite persistence for Wisps and conversations: a row per Wisp, conversation,
 * circle member, session, and message, so a change writes only the rows it
 * touches instead of the whole store. Records are stored as columns, and what
 * relates them as foreign keys; messages keep their body as JSON. Rowids
 * preserve insertion order, and upserts keep a row's position. A full-text
 * index over messages is kept in sync by triggers. All writes run inside
 * `transaction`.
 *
 * A store from before layout 5 held whole records as JSON. It is read as such
 * until `rebuild` rewrites it in this layout.
 */
export class ConversationStore {
  private readonly statements = new Map<string, StatementSync>();

  private constructor(
    private readonly db: DatabaseSync,
    private jsonRecords: boolean,
  ) {}

  /**
   * Opens or creates the database. An older layout is upgraded in place as
   * far as SQL alone can take it; `hasJsonRecords` then says it still needs
   * `rebuild`. Throws if the file is not a usable SQLite database.
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
      `);
      const version = db.prepare("SELECT value FROM meta WHERE key = 'store_version'").get()?.value;
      const minReader = db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").get()?.value ?? version;
      if (Number(minReader) > STORE_VERSION) {
        throw new IntactDatabaseError(
          `Conversations were saved by a newer version of Wisp Bot. Install it again, or replace ${path.basename(filePath)} with a ${path.basename(filePath)}.v<N>.backup beside it, N at most ${STORE_VERSION}.`,
        );
      }
      if (version !== undefined && Number(version) < STORE_VERSION) backUpBeforeUpgrade(db, filePath, Number(version));
      if (version === undefined) {
        // Nothing was ever committed here, so any tables are empty leftovers
        // of an interrupted first run, possibly in an older layout.
        db.exec(
          [...JSON_RECORD_TABLES, "circle_members", "participant_sessions", "messages"]
            .map((table) => `DROP TABLE IF EXISTS ${table};`)
            .join("\n"),
        );
      }
      const jsonRecords = version !== undefined && Number(version) < COLUMN_RECORDS_VERSION;
      if (!jsonRecords) db.exec(`${RECORD_SCHEMA}${PENDING_MESSAGES_SCHEMA}${JOBS_SCHEMA}`);
      db.exec(`${MESSAGES_SCHEMA}${SEARCH_SCHEMA}`);
      const store = new ConversationStore(db, jsonRecords);
      if (Number(version) < 2) store.upgradeFromVersion1();
      if (!jsonRecords) {
        store.upgradeShapeToAppearance();
        store.dropWispPictures();
        store.addUnreadCounts();
        store.addPinnedConversations();
        store.addWispThinkingLevels();
        store.addWispFallbacks();
        store.addWispMemoryOff();
        if (version !== undefined) store.renameJobRunSessionFiles(Number(version) < WISP_FOLDERS_VERSION);
        if (version !== undefined && Number(version) < AUTHOR_NAMES_VERSION) store.nameMessageAuthors();
      }
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

  /** True while the store holds records in the JSON layout from before version 5. */
  hasJsonRecords(): boolean {
    return this.jsonRecords;
  }

  read(): StoredConversationState {
    // A newer app version may have changed the layout in a way this build
    // cannot read or write safely; never guess at it.
    const minReader = Number(this.getMeta("min_reader_version") ?? this.getMeta("store_version"));
    if (!Number.isInteger(minReader) || minReader > STORE_VERSION) {
      throw new Error("Unsupported conversation store version.");
    }
    const { wisps, conversations } = this.jsonRecords ? this.readJsonRecords() : this.readRecords();
    for (const row of this.db.prepare("SELECT conversation_id, body FROM messages ORDER BY seq").iterate()) {
      conversations[String(row.conversation_id)]?.chat.messages.push(JSON.parse(String(row.body)));
    }
    return { initialized: this.getMeta("initialized") === "1", wisps, conversations };
  }

  /** One page of a conversation's messages; see `MessagePageRequest`. */
  readPage(conversationId: string, request: StoredPageRequest): StoredMessagePage {
    switch (request.page) {
      case "latest": {
        const rows = this.rows(this.messagesSelect("ORDER BY seq DESC LIMIT ?"), conversationId, MESSAGE_PAGE_SIZE + 1);
        const page = rows.slice(0, MESSAGE_PAGE_SIZE).reverse();
        return this.page(page, rows.length > MESSAGE_PAGE_SIZE, false);
      }
      case "older": {
        const rows = this.rows(this.olderStatement(), conversationId, request.before, MESSAGE_PAGE_SIZE + 1);
        const page = rows.slice(0, MESSAGE_PAGE_SIZE).reverse();
        const newestSeq = page.at(-1)?.seq ?? request.before - 1;
        return this.page(page, rows.length > MESSAGE_PAGE_SIZE, this.hasNewer(conversationId, newestSeq), {
          emptyOlder: request.before,
          emptyNewer: newestSeq,
        });
      }
      case "newer": {
        const rows = this.rows(
          this.messagesSelect("AND seq > ? ORDER BY seq ASC LIMIT ?"),
          conversationId,
          request.after,
          MESSAGE_PAGE_SIZE + 1,
        );
        const page = rows.slice(0, MESSAGE_PAGE_SIZE);
        const oldestSeq = page[0]?.seq ?? request.after + 1;
        return this.page(page, this.hasOlder(conversationId, oldestSeq), rows.length > MESSAGE_PAGE_SIZE, {
          emptyOlder: oldestSeq,
          emptyNewer: request.after,
        });
      }
      case "around": {
        const target = this.rows(this.messageStatement(), conversationId, request.messageId)[0];
        if (!target) return { messages: [], olderCursor: null, newerCursor: null };
        const before = this.rows(this.olderStatement(), conversationId, target.seq, MESSAGE_PAGE_RADIUS + 1);
        const after = this.rows(
          this.messagesSelect("AND seq >= ? ORDER BY seq ASC LIMIT ?"),
          conversationId,
          target.seq,
          MESSAGE_PAGE_RADIUS + 2,
        );
        const page = [...before.slice(0, MESSAGE_PAGE_RADIUS).reverse(), ...after.slice(0, MESSAGE_PAGE_RADIUS + 1)];
        return this.page(page, before.length > MESSAGE_PAGE_RADIUS, after.length > MESSAGE_PAGE_RADIUS + 1);
      }
    }
  }

  /** A stored message body by ID, through the (conversation, message ID) index. */
  getMessage(conversationId: string, messageId: string): unknown {
    return this.rows(this.messageStatement(), conversationId, messageId)[0]?.body;
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
      this.raiseVersions();
      write();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Rewrites a store with JSON records in this layout, in one transaction:
   * Wisps and conversations from `records` (messages stay where they are),
   * and the pending messages given. Messages left without a conversation are
   * removed.
   */
  rebuild(
    records: Pick<WorkspaceRecords, "wisps" | "conversations">,
    pending: { scheduled: ReadonlyArray<ScheduledMessage>; queued: ReadonlyArray<QueuedMessage> },
  ): void {
    // Dropping a parent table with foreign keys on would delete every message.
    // The pragma has no effect inside a transaction, so it wraps it.
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.statements.clear();
        this.db.exec(JSON_RECORD_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join("\n"));
        this.db.exec(`${RECORD_SCHEMA}${PENDING_MESSAGES_SCHEMA}${JOBS_SCHEMA}`);
        for (const column of MESSAGE_COLUMNS) this.db.exec(`ALTER TABLE messages ADD COLUMN ${column}`);
        for (const record of Object.values(records.wisps)) this.putWisp(record);
        for (const record of Object.values(records.conversations)) this.putConversation(record);
        this.db.exec("DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)");
        this.db.exec(NAME_MESSAGE_AUTHORS);
        for (const message of pending.scheduled) {
          if (records.conversations[message.conversationId]) this.putScheduledMessage(message);
        }
        for (const message of pending.queued) {
          if (records.conversations[message.conversationId]) this.putQueuedMessage(message);
        }
        if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw new Error("The rebuilt conversation store has broken references.");
        }
      });
    } catch (error) {
      this.statements.clear();
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    this.jsonRecords = false;
  }

  replaceAll(state: {
    initialized: boolean;
    wisps: Readonly<Record<string, WispRecord>>;
    conversations: Readonly<Record<string, ConversationRecord>>;
  }): void {
    this.db.exec("DELETE FROM conversations");
    this.db.exec("DELETE FROM wisps");
    for (const record of Object.values(state.wisps)) this.putWisp(record);
    for (const record of Object.values(state.conversations)) {
      this.putConversation(record);
      this.putMessages(record.chat.id, record.chat.messages);
    }
    this.setInitialized(state.initialized);
  }

  putWisp(record: WispRecord): void {
    const { wisp, modelOverride, fallback } = record;
    const { appearance } = wisp;
    this.statement(
      `INSERT INTO wisps (id, name, role, soul, body, trail, tone, eyes, eye_ink, finish, mark, color,
        storage_id, model_provider_id, model_id, model_max_output_tokens, model_thinking_level,
        fallback_mode, fallback_provider_id, fallback_model_id, memory_off, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, role = excluded.role, soul = excluded.soul,
        body = excluded.body, trail = excluded.trail, tone = excluded.tone, eyes = excluded.eyes,
        eye_ink = excluded.eye_ink, finish = excluded.finish, mark = excluded.mark,
        color = excluded.color, storage_id = excluded.storage_id,
        model_provider_id = excluded.model_provider_id, model_id = excluded.model_id,
        model_max_output_tokens = excluded.model_max_output_tokens,
        model_thinking_level = excluded.model_thinking_level,
        fallback_mode = excluded.fallback_mode, fallback_provider_id = excluded.fallback_provider_id,
        fallback_model_id = excluded.fallback_model_id, memory_off = excluded.memory_off,
        created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ).run(
      wisp.id,
      wisp.name,
      wisp.role,
      wisp.soul,
      appearance.body,
      appearance.trail,
      appearance.tone,
      appearance.eyes,
      appearance.eyeInk,
      appearance.finish,
      appearance.mark,
      wisp.color ?? null,
      record.storageId,
      modelOverride?.providerId ?? null,
      modelOverride?.modelId ?? null,
      modelOverride?.maxOutputTokens ?? null,
      modelOverride?.thinkingLevel ?? null,
      fallback === undefined ? null : typeof fallback === "string" ? fallback : "model",
      typeof fallback === "object" ? fallback.providerId : null,
      typeof fallback === "object" ? fallback.modelId : null,
      wisp.memoryOff ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    );
  }

  /** Deletes the Wisp and, through foreign keys, its own conversation and its places in circles. */
  deleteWisp(wispId: string): void {
    this.statement("DELETE FROM wisps WHERE id = ?").run(wispId);
  }

  /** Writes the conversation with its members and sessions; its messages are stored separately. */
  putConversation(record: ConversationRecord): void {
    const { chat } = record;
    const circle = chat.kind === "circle" ? chat : undefined;
    this.statement(
      `INSERT INTO conversations (id, kind, wisp_id, name, label, description, notify_on_updates_enabled,
        preview, unread, unread_count, pinned, last_activity_at, storage_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        kind = excluded.kind, wisp_id = excluded.wisp_id, name = excluded.name, label = excluded.label,
        description = excluded.description, notify_on_updates_enabled = excluded.notify_on_updates_enabled,
        preview = excluded.preview, unread = excluded.unread, unread_count = excluded.unread_count,
        pinned = excluded.pinned, last_activity_at = excluded.last_activity_at,
        storage_id = excluded.storage_id, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ).run(
      chat.id,
      chat.kind,
      chat.kind === "wisp" ? chat.wispId : null,
      circle?.name ?? null,
      circle?.label ?? null,
      circle?.description ?? null,
      chat.notifyOnUpdatesEnabled ? 1 : 0,
      chat.preview,
      chat.unread === undefined ? null : chat.unread ? 1 : 0,
      chat.unreadCount ?? null,
      chat.pinned ? 1 : 0,
      chat.lastActivityAt ?? null,
      record.storageId,
      record.createdAt,
      record.updatedAt,
    );
    this.statement("DELETE FROM circle_members WHERE conversation_id = ?").run(chat.id);
    const member = this.statement("INSERT INTO circle_members (conversation_id, wisp_id, position) VALUES (?, ?, ?)");
    circle?.memberIds.forEach((wispId, position) => member.run(chat.id, wispId, position));
    this.statement("DELETE FROM participant_sessions WHERE conversation_id = ?").run(chat.id);
    const session = this.statement(
      "INSERT INTO participant_sessions (conversation_id, wisp_id, session_id, pi_session_id, pi_session_file) VALUES (?, ?, ?, ?, ?)",
    );
    for (const [wispId, { sessionId, piSessionId, piSessionFile }] of Object.entries(record.sessions)) {
      session.run(chat.id, wispId, sessionId, piSessionId, piSessionFile);
    }
  }

  putMessages(conversationId: string, messages: ReadonlyArray<Message>): void {
    const put = this.statement(
      "INSERT INTO messages (conversation_id, id, body) VALUES (?, ?, ?) ON CONFLICT (conversation_id, id) DO UPDATE SET body = excluded.body",
    );
    for (const message of messages) {
      if (!message.id) throw new Error("Stored messages require an ID.");
      put.run(conversationId, message.id, JSON.stringify(message));
    }
  }

  deleteOldestMessages(conversationId: string, count: number): void {
    if (count <= 0) return;
    this.statement(
      "DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT ?)",
    ).run(conversationId, count);
  }

  /** Deletes the conversation and, through foreign keys, everything in it. */
  deleteConversation(conversationId: string): void {
    this.statement("DELETE FROM conversations WHERE id = ?").run(conversationId);
  }

  /** Raw scheduled message records, soonest first; validated by the repository. */
  readScheduledMessages(): unknown[] {
    const order = "ORDER BY next_run_at, seq";
    if (this.jsonRecords) return this.readJsonRows("scheduled_messages", order);
    return this.db.prepare(`SELECT * FROM scheduled_messages ${order}`).all().map(scheduledMessageOf);
  }

  putScheduledMessage(message: ScheduledMessage): void {
    this.statement(
      `INSERT INTO scheduled_messages (id, conversation_id, text, schedule, time_zone, next_run_at,
        sent_count, last_sent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        text = excluded.text, schedule = excluded.schedule, time_zone = excluded.time_zone,
        next_run_at = excluded.next_run_at, sent_count = excluded.sent_count,
        last_sent_at = excluded.last_sent_at, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ).run(
      message.id,
      message.conversationId,
      message.text,
      JSON.stringify(message.schedule),
      message.timeZone,
      message.nextRunAt,
      message.sentCount,
      message.lastSentAt ?? null,
      message.createdAt,
      message.updatedAt,
    );
  }

  deleteScheduledMessage(id: string): void {
    this.statement("DELETE FROM scheduled_messages WHERE id = ?").run(id);
  }

  /** Raw queued message records, oldest first; validated by the repository. */
  readQueuedMessages(): unknown[] {
    if (this.jsonRecords) return this.readJsonRows("queued_messages", "ORDER BY seq");
    return this.db.prepare("SELECT * FROM queued_messages ORDER BY seq").all().map(queuedMessageOf);
  }

  putQueuedMessage(message: QueuedMessage): void {
    // An edit keeps the message's place in line.
    this.statement(
      `INSERT INTO queued_messages (id, conversation_id, text, created_at, scheduled_message_id, scheduled_at, scheduled_time_zone)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        text = excluded.text, created_at = excluded.created_at, scheduled_message_id = excluded.scheduled_message_id,
        scheduled_at = excluded.scheduled_at, scheduled_time_zone = excluded.scheduled_time_zone`,
    ).run(
      message.id,
      message.conversationId,
      message.text,
      message.createdAt,
      message.scheduled?.scheduledMessageId ?? null,
      message.scheduled?.scheduledAt ?? null,
      message.scheduled?.timeZone ?? null,
    );
  }

  deleteQueuedMessage(id: string): void {
    this.statement("DELETE FROM queued_messages WHERE id = ?").run(id);
  }

  /** Raw job records, soonest next run first and ended jobs last; validated by the repository. */
  readJobs(): unknown[] {
    if (this.jsonRecords) return [];
    return this.db.prepare("SELECT * FROM jobs ORDER BY next_run_at IS NULL, next_run_at, seq").all().map(jobOf);
  }

  putJob(job: Job): void {
    const nullableJson = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
    this.statement(
      `INSERT INTO jobs (id, conversation_id, title, instructions, skills, tools, schedule, time_zone, next_run_at,
        retry, paused, state, run_count, consecutive_failures, last_run, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        title = excluded.title, instructions = excluded.instructions, skills = excluded.skills,
        tools = excluded.tools, schedule = excluded.schedule, time_zone = excluded.time_zone,
        next_run_at = excluded.next_run_at, retry = excluded.retry, paused = excluded.paused,
        state = excluded.state, run_count = excluded.run_count,
        consecutive_failures = excluded.consecutive_failures, last_run = excluded.last_run,
        created_at = excluded.created_at, updated_at = excluded.updated_at`,
    ).run(
      job.id,
      job.conversationId,
      job.title,
      job.instructions,
      JSON.stringify(job.skills),
      JSON.stringify(job.tools),
      JSON.stringify(job.schedule),
      job.timeZone,
      job.nextRunAt ?? null,
      nullableJson(job.retry),
      nullableJson(job.paused),
      job.state,
      job.runCount,
      job.consecutiveFailures,
      nullableJson(job.lastRun),
      job.createdAt,
      job.updatedAt,
    );
  }

  /** Deletes the job and, through foreign keys, its runs. */
  deleteJob(id: string): void {
    this.statement("DELETE FROM jobs WHERE id = ?").run(id);
  }

  /** Raw run records of a job, newest first; validated by the repository. */
  readJobRuns(jobId: string, limit: number): unknown[] {
    if (this.jsonRecords) return [];
    return this.statement("SELECT * FROM job_runs WHERE job_id = ? ORDER BY seq DESC LIMIT ?")
      .all(jobId, limit)
      .map(jobRunOf);
  }

  /** Writes a run record, keeping only the newest `keep` of its job; returns the session files of runs removed. */
  putJobRun(run: JobRun, keep: number): string[] {
    this.statement(
      `INSERT INTO job_runs (id, job_id, conversation_id, trigger, scheduled_at, started_at, ended_at, status,
        error_code, delivery_error_code, skip_reason, usage, message_id, session_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        ended_at = excluded.ended_at, status = excluded.status, error_code = excluded.error_code,
        delivery_error_code = excluded.delivery_error_code, skip_reason = excluded.skip_reason,
        usage = excluded.usage, message_id = excluded.message_id, session_file = excluded.session_file`,
    ).run(
      run.id,
      run.jobId,
      run.conversationId,
      run.trigger,
      run.scheduledAt,
      run.startedAt,
      run.endedAt ?? null,
      run.status ?? null,
      run.errorCode ?? null,
      run.deliveryErrorCode ?? null,
      run.skipReason ?? null,
      run.usage === undefined ? null : JSON.stringify(run.usage),
      run.messageId ?? null,
      run.sessionFile ?? null,
    );
    const stale = "job_id = ? AND seq NOT IN (SELECT seq FROM job_runs WHERE job_id = ? ORDER BY seq DESC LIMIT ?)";
    const files = this.statement(`SELECT session_file FROM job_runs WHERE session_file IS NOT NULL AND ${stale}`)
      .all(run.jobId, run.jobId, keep)
      .map((row) => String(row.session_file));
    this.statement(`DELETE FROM job_runs WHERE ${stale}`).run(run.jobId, run.jobId, keep);
    return files;
  }

  setInitialized(initialized: boolean): void {
    this.statement(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run("initialized", initialized ? "1" : "0");
  }

  /** The open connection, for stores that keep their own tables in this file, such as memory (ADR 029). */
  get database(): DatabaseSync {
    return this.db;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private readRecords() {
    const wisps: Record<string, unknown> = {};
    for (const row of this.db.prepare("SELECT * FROM wisps ORDER BY seq").iterate()) {
      wisps[String(row.id)] = wispRecordOf(row);
    }
    const conversations: Record<string, ReturnType<typeof conversationRecordOf>> = {};
    for (const row of this.db.prepare("SELECT * FROM conversations ORDER BY seq").iterate()) {
      conversations[String(row.id)] = conversationRecordOf(row);
    }
    const members = "SELECT conversation_id, wisp_id FROM circle_members ORDER BY conversation_id, position";
    for (const row of this.db.prepare(members).iterate()) {
      (conversations[String(row.conversation_id)]?.chat.memberIds as unknown[] | undefined)?.push(row.wisp_id);
    }
    for (const row of this.db.prepare("SELECT * FROM participant_sessions ORDER BY rowid").iterate()) {
      const record = conversations[String(row.conversation_id)];
      if (!record) continue;
      record.sessions[String(row.wisp_id)] = {
        sessionId: row.session_id,
        piSessionId: row.pi_session_id,
        piSessionFile: row.pi_session_file,
      };
    }
    return { wisps, conversations };
  }

  /** Records as layouts 1 to 4 stored them, for the repository to upgrade. */
  private readJsonRecords() {
    const wisps: Record<string, unknown> = {};
    if (this.hasTable("wisps")) {
      for (const row of this.db.prepare("SELECT id, record FROM wisps ORDER BY seq").iterate()) {
        wisps[String(row.id)] = JSON.parse(String(row.record));
      }
    }
    const conversations: Record<string, { chat: { messages: unknown[] } }> = {};
    for (const row of this.db.prepare("SELECT id, record FROM conversations ORDER BY seq").iterate()) {
      const record = JSON.parse(String(row.record)) as { chat: Record<string, unknown> };
      conversations[String(row.id)] = { ...record, chat: { ...record.chat, messages: [] } };
    }
    return { wisps, conversations };
  }

  private readJsonRows(table: string, order: string): unknown[] {
    if (!this.hasTable(table)) return [];
    return this.db
      .prepare(`SELECT record FROM ${table} ${order}`)
      .all()
      .map((row) => JSON.parse(String(row.record)));
  }

  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  // Version 1 had no search index and no stored last activity. Its records
  // stay JSON until the repository rebuilds the store.
  private upgradeFromVersion1(): void {
    if (!this.isEstablished()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(UPGRADE_FROM_VERSION_1);
      this.db.prepare("UPDATE meta SET value = '2' WHERE key = 'store_version'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upgradeShapeToAppearance(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('wisps')").all();
    if (!columns.some((column) => column.name === "shape")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(UPGRADE_SHAPE_TO_APPEARANCE);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Raises the version markers in the same transaction, so a version 5 build
  // never writes to the table without the column.
  private dropWispPictures(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('wisps')").all();
    if (!columns.some((column) => column.name === "avatar_image")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(DROP_WISP_PICTURES);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addUnreadCounts(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('conversations')").all();
    if (columns.some((column) => column.name === "unread_count")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(ADD_UNREAD_COUNTS);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addPinnedConversations(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('conversations')").all();
    if (columns.some((column) => column.name === "pinned")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(ADD_PINNED_CONVERSATIONS);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addWispThinkingLevels(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('wisps')").all();
    if (columns.some((column) => column.name === "model_thinking_level")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(ADD_WISP_THINKING_LEVELS);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addWispFallbacks(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('wisps')").all();
    if (columns.some((column) => column.name === "fallback_mode")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(ADD_WISP_FALLBACKS);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private addWispMemoryOff(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('wisps')").all();
    if (columns.some((column) => column.name === "memory_off")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(ADD_WISP_MEMORY_OFF);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // A run's file is only ever deleted from inside the session folders, so one
  // named under the old folder would be left on disk when its run is pruned.
  // Runs again when an interrupted upgrade (the version is raised by whichever
  // step comes first) left some behind.
  private renameJobRunSessionFiles(upgrading: boolean): void {
    const rows = this.db.prepare("SELECT DISTINCT session_file FROM job_runs WHERE session_file IS NOT NULL").all();
    const renames = rows
      .map(({ session_file: file }) => [String(file), renamedSessionFile(String(file))] as const)
      .filter(([file, renamed]) => renamed !== file);
    if (!upgrading && !renames.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE job_runs SET session_file = ? WHERE session_file = ?");
      for (const [file, renamed] of renames) update.run(renamed, file);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private nameMessageAuthors(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(NAME_MESSAGE_AUTHORS);
      this.raiseVersions();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Version markers only rise: an older build writing here must not lower them.
  private raiseVersions(): void {
    const raise = this.statement(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER)",
    );
    raise.run("store_version", String(STORE_VERSION));
    raise.run("min_reader_version", String(MIN_READER_VERSION));
  }

  /** Prepares a statement once; `rebuild` drops the cache with the tables it replaces. */
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private messagesSelect(clause: string): StatementSync {
    return this.statement(`SELECT seq, body FROM messages WHERE conversation_id = ? ${clause}`);
  }

  private olderStatement(): StatementSync {
    return this.messagesSelect("AND seq < ? ORDER BY seq DESC LIMIT ?");
  }

  private messageStatement(): StatementSync {
    return this.messagesSelect("AND id = ?");
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
    const found = this.statement(
      "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND seq < ?) AS found",
    ).get(conversationId, seq)?.found;
    return Number(found) === 1;
  }

  private hasNewer(conversationId: string, seq: number): boolean {
    const found = this.statement(
      "SELECT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ?) AS found",
    ).get(conversationId, seq)?.found;
    return Number(found) === 1;
  }

  private getMeta(key: string): string | undefined {
    const row = this.statement("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  }
}
