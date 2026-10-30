import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { RuntimeEventEntry, RuntimeEventLogView, RuntimeEventSource } from "../shared/runtime-events.js";
import { writeFileAtomically } from "./atomic-file.js";

const DEFAULT_MAX_EVENTS = 1_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_STRING_CHARACTERS = 2_000;
const MAX_PAYLOAD_CHARACTERS = 16_000;
const MAX_DEPTH = 12;
/** Keys whose values are credentials wherever they appear; their values are never recorded. */
const SECRET_KEY =
  /^(api[-_]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|password|secret|client[-_]?secret|(access|refresh|id|bearer)?[-_]?token)$/i;
/** Saved credentials are read again at most this often while events arrive. */
const SECRETS_TTL_MS = 5_000;
/** Shorter values are not masked: they would hide ordinary words and numbers, not keys. */
const MIN_SECRET_CHARACTERS = 8;
const REDACTED = "[redacted]";
const RECORDING_FILE = "recording.json";
const LOG_EXTENSION = ".jsonl";
const ROTATED_SUFFIX = ".1";

export interface RuntimeEventLogOptions {
  /** The environment's folder for runtime event files: one per conversation, and which ones record. */
  directory: string;
  /** Events a conversation's view keeps. */
  maxEvents?: number;
  /** Size of a conversation's file before it rotates to `<file>.1`, replacing the previous one. */
  maxFileBytes?: number;
  now?: () => Date;
  /** The values of the credentials Wisp keeps, which are masked wherever they appear in an event. */
  secretValues?: () => Promise<ReadonlyArray<string>>;
}

interface ConversationLog {
  events: RuntimeEventEntry[];
  dropped: boolean;
  sequence: number;
  fileBytes: number;
}

/**
 * The raw events of the conversations someone is debugging (SWE-215). Only
 * conversations with recording turned on keep events. Each conversation's go
 * to a JSON Lines file in the environment's data directory, which rotates
 * like `backend.log`, and the latest of them are kept for the view. Which
 * conversations record is saved too, so recording goes on after a restart.
 *
 * Every change goes through one queue, so events are written in the order
 * they arrived and a read sees every event recorded before it.
 */
export class RuntimeEventLog {
  private readonly directory: string;
  private readonly maxEvents: number;
  private readonly maxFileBytes: number;
  private readonly now: () => Date;
  private readonly secretValues: () => Promise<ReadonlyArray<string>>;
  private readonly recording = new Set<string>();
  private readonly logs = new Map<string, ConversationLog>();
  private secrets: { values: ReadonlyArray<string>; readAt: number } | undefined;
  private directoryReady: Promise<unknown> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RuntimeEventLogOptions) {
    this.directory = options.directory;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.now = options.now ?? (() => new Date());
    this.secretValues = options.secretValues ?? (async () => []);
  }

  /** Reads which conversations were recording; a missing or unreadable file means none. */
  async load(): Promise<void> {
    await this.enqueue(async () => {
      const saved = await readFile(path.join(this.directory, RECORDING_FILE), "utf8")
        .then((content) => (JSON.parse(content) as { conversations?: unknown }).conversations)
        .catch(() => undefined);
      if (!Array.isArray(saved)) return;
      for (const id of saved) if (typeof id === "string" && isFileId(id)) this.recording.add(id);
      if (this.recording.size) await this.currentSecrets();
    });
  }

  isRecording(conversationId: string): boolean {
    return this.recording.has(conversationId);
  }

  /** Starts or stops recording. Stopping keeps what was recorded, so it can still be read, copied or saved. */
  async setRecording(conversationId: string, recording: boolean): Promise<RuntimeEventLogView> {
    await this.enqueue(async () => {
      if (recording === this.recording.has(conversationId)) return;
      if (recording) {
        this.recording.add(conversationId);
        // Credentials saved since the last recording are masked from its first event.
        this.secrets = undefined;
        await this.currentSecrets();
      } else {
        this.recording.delete(conversationId);
      }
      await this.saveRecording();
    });
    return this.read(conversationId);
  }

  /** Keeps a runtime's event when its conversation is recording; otherwise does nothing, cheaply. */
  record(conversationId: string, runtime: RuntimeEventSource, event: unknown, wispId?: string): void {
    if (!this.recording.has(conversationId)) return;
    const type = (event as { type?: unknown } | null)?.type;
    const receivedAt = this.now().toISOString();
    // Copied now: a runtime may change the object after emitting it. The credentials
    // known so far are masked before long strings are cut, so no part of one is kept.
    const payload = debugPayload(event, this.secrets?.values);
    void this.enqueue(async () => {
      if (!this.recording.has(conversationId)) return;
      const secrets = await this.currentSecrets();
      const log = await this.open(conversationId);
      const entry: RuntimeEventEntry = {
        sequence: ++log.sequence,
        ...(wispId ? { wispId } : {}),
        runtime,
        type: typeof type === "string" && type ? maskSecrets(type.slice(0, 120), secrets) : "unknown",
        receivedAt,
        payload: maskPayload(payload, secrets),
      };
      log.events.push(entry);
      if (log.events.length > this.maxEvents) {
        log.events.splice(0, log.events.length - this.maxEvents);
        log.dropped = true;
      }
      await this.append(conversationId, log, entry);
    }).catch(() => undefined);
  }

  /** The latest events, or those after `after`; after a restart, read back from the conversation's file. */
  read(conversationId: string, after?: number): Promise<RuntimeEventLogView> {
    return this.enqueue(async () => {
      const log = await this.open(conversationId);
      return {
        conversationId,
        recording: this.recording.has(conversationId),
        events: after === undefined ? [...log.events] : log.events.filter(({ sequence }) => sequence > after),
        dropped: log.dropped,
      };
    });
  }

  /** Deletes what the conversation recorded; recording goes on if it was on. */
  async clear(conversationId: string): Promise<RuntimeEventLogView> {
    await this.enqueue(async () => {
      const log = await this.open(conversationId);
      // Sequences go on, so a view reading after the old ones misses nothing new.
      this.logs.set(conversationId, { events: [], dropped: false, sequence: log.sequence, fileBytes: 0 });
      await this.removeFiles(conversationId);
    });
    return this.read(conversationId);
  }

  /** Everything still on disk for the conversation, oldest first, as JSON Lines. */
  contents(conversationId: string): Promise<Buffer> {
    return this.enqueue(async () => {
      const file = this.filePath(conversationId);
      const parts = await Promise.all(
        [`${file}${ROTATED_SUFFIX}`, file].map((part) => readFile(part).catch(() => null)),
      );
      return Buffer.concat(parts.flatMap((part) => (part ? [part] : [])));
    });
  }

  /** Deletes the files and the recording of every conversation not in `existing`, such as deleted ones. */
  reconcile(existing: ReadonlySet<string>): Promise<void> {
    return this.enqueue(async () => {
      const names = await readdir(this.directory).catch(() => [] as string[]);
      const stale = new Set(names.flatMap((name) => conversationOf(name) ?? []));
      for (const id of [...this.recording, ...this.logs.keys()]) stale.add(id);
      let recordingChanged = false;
      for (const id of stale) {
        if (existing.has(id)) continue;
        this.logs.delete(id);
        if (this.recording.delete(id)) recordingChanged = true;
        await this.removeFiles(id);
      }
      if (recordingChanged) await this.saveRecording();
    });
  }

  /** Bytes the runtime event files take, for **Settings → Storage**. */
  measure(): Promise<number> {
    return this.enqueue(async () => {
      const names = await readdir(this.directory).catch(() => [] as string[]);
      const sizes = await Promise.all(
        names.map((name) =>
          stat(path.join(this.directory, name)).then(
            (info) => (info.isFile() ? info.size : 0),
            () => 0,
          ),
        ),
      );
      return sizes.reduce((sum, size) => sum + size, 0);
    });
  }

  /** Resolves once every event recorded so far is written. */
  async flush(): Promise<void> {
    await this.enqueue(async () => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** The saved credentials, read again once they may have changed; the last ones when they cannot be read. */
  private async currentSecrets(): Promise<ReadonlyArray<string>> {
    const now = Date.now();
    if (this.secrets && now - this.secrets.readAt < SECRETS_TTL_MS) return this.secrets.values;
    const values = await this.secretValues().catch(() => this.secrets?.values ?? []);
    // Longest first, so a key containing another is masked whole.
    const unique = [...new Set(values)].filter((value) => value.length >= MIN_SECRET_CHARACTERS);
    this.secrets = { values: unique.sort((a, b) => b.length - a.length), readAt: now };
    return this.secrets.values;
  }

  private async open(conversationId: string): Promise<ConversationLog> {
    const loaded = this.logs.get(conversationId);
    if (loaded) return loaded;
    const file = this.filePath(conversationId);
    const current = await readFile(file, "utf8").catch(() => "");
    let entries = parseEntries(current);
    let dropped = false;
    if (entries.length < this.maxEvents) {
      const rotated = await readFile(`${file}${ROTATED_SUFFIX}`, "utf8").catch(() => "");
      entries = [...parseEntries(rotated), ...entries];
    } else {
      dropped = true;
    }
    if (entries.length > this.maxEvents) {
      entries = entries.slice(-this.maxEvents);
      dropped = true;
    }
    const log = {
      events: entries,
      dropped,
      sequence: entries.at(-1)?.sequence ?? 0,
      fileBytes: Buffer.byteLength(current),
    };
    this.logs.set(conversationId, log);
    return log;
  }

  private async append(conversationId: string, log: ConversationLog, entry: RuntimeEventEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line);
    const file = this.filePath(conversationId);
    try {
      await this.ensureDirectory();
      if (log.fileBytes > 0 && log.fileBytes + bytes > this.maxFileBytes) {
        await rename(file, `${file}${ROTATED_SUFFIX}`).catch(() => undefined);
        log.fileBytes = 0;
      }
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      log.fileBytes += bytes;
    } catch {
      // Debugging must never take a conversation down; the view still has the event.
    }
  }

  private async saveRecording(): Promise<void> {
    await this.ensureDirectory();
    const conversations = [...this.recording].sort();
    await writeFileAtomically(
      path.join(this.directory, RECORDING_FILE),
      `${JSON.stringify({ schemaVersion: 1, conversations }, null, 2)}\n`,
    );
  }

  private async removeFiles(conversationId: string): Promise<void> {
    const file = this.filePath(conversationId);
    await Promise.all([rm(file, { force: true }), rm(`${file}${ROTATED_SUFFIX}`, { force: true })]);
  }

  private ensureDirectory(): Promise<unknown> {
    // Owner-only, like the data directory: events hold prompts and replies.
    this.directoryReady ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).catch((error) => {
      this.directoryReady = undefined;
      throw error;
    });
    return this.directoryReady;
  }

  private filePath(conversationId: string): string {
    if (!isFileId(conversationId)) throw new Error("A conversation ID cannot name a file.");
    return path.join(this.directory, `${conversationId}${LOG_EXTENSION}`);
  }
}

/** Conversation IDs as the validators accept them, which are safe file names. */
function isFileId(value: string): boolean {
  return value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value) && !value.includes("..");
}

/** The conversation a file in the folder belongs to, or undefined for other files. */
function conversationOf(name: string): string | undefined {
  const base = name.endsWith(ROTATED_SUFFIX) ? name.slice(0, -ROTATED_SUFFIX.length) : name;
  if (!base.endsWith(LOG_EXTENSION)) return undefined;
  const id = base.slice(0, -LOG_EXTENSION.length);
  return isFileId(id) ? id : undefined;
}

function parseEntries(content: string): RuntimeEventEntry[] {
  return content.split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      const entry = JSON.parse(line) as RuntimeEventEntry;
      return typeof entry?.sequence === "number" && typeof entry.type === "string" ? [entry] : [];
    } catch {
      // A line cut by a crash is skipped.
      return [];
    }
  });
}

function maskSecrets(text: string, secrets: ReadonlyArray<string> | undefined): string {
  if (!secrets) return text;
  let masked = text;
  for (const secret of secrets) if (masked.includes(secret)) masked = masked.replaceAll(secret, REDACTED);
  return masked;
}

/** Masks the credentials in every string of a payload `debugPayload` made. */
function maskPayload(value: unknown, secrets: ReadonlyArray<string>): unknown {
  if (!secrets.length) return value;
  if (typeof value === "string") return maskSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskPayload(item, secrets)]));
  }
  return value;
}

/**
 * A runtime event as plain JSON: credentials replaced, long strings and deep
 * nesting cut, cycles and functions dropped, and the whole bounded, so a
 * misbehaving runtime cannot fill the disk or leak a key. `secrets` are
 * masked in every string before it is cut.
 */
export function debugPayload(value: unknown, secrets?: ReadonlyArray<string>): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") {
      const text = maskSecrets(current, secrets);
      return text.length > MAX_STRING_CHARACTERS
        ? `${text.slice(0, MAX_STRING_CHARACTERS)}… (${text.length} characters)`
        : text;
    }
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint") return current.toString();
    if (current === null || typeof current === "boolean") return current;
    if (typeof current !== "object") return undefined;
    if (seen.has(current)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[nested too deep]";
    seen.add(current);
    try {
      if (current instanceof Error) return { name: current.name, message: visit(current.message, depth + 1) };
      if (current instanceof Date) return current.toISOString();
      if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return `[${current.byteLength} bytes]`;
      if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1) ?? null);
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        if (SECRET_KEY.test(key) && item !== null && item !== undefined && item !== "") {
          result[key] = REDACTED;
          continue;
        }
        const next = visit(item, depth + 1);
        if (next !== undefined) result[key] = next;
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };
  const payload = visit(value, 0);
  const json = JSON.stringify(payload) ?? "null";
  if (json.length <= MAX_PAYLOAD_CHARACTERS) return payload;
  return { truncated: true, characters: json.length, preview: json.slice(0, MAX_PAYLOAD_CHARACTERS) };
}
