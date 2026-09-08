import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  fstatSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "../errors.js";
import { normalizeSelection } from "../../backend/ai-settings-store.js";
import { normalizeToolPolicy } from "../../backend/tool-policy-store.js";
import {
  normalizeChat,
  normalizeMessage,
  normalizeConversationId,
  validateConversationGraph,
} from "../../backend/conversation-normalizer.js";
import type { ConversationRecord } from "../../backend/workspace-actions.js";
import type { ServerDatabase } from "../storage/database.js";
import type { SqliteConversationRepository } from "../storage/conversation-repository.js";

const MAGIC = Buffer.from("WISP-ARCHIVE-1\n");
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
const ROOTS = ["workspaces", "pi-sessions", "pi-config"] as const;
const SETTINGS = ["ai-settings.json", "tool-policy.json", "model-pricing.json"] as const;
const BACKUP_FILES = [...SETTINGS, "wisp.sqlite", "credentials.enc.json", "tool-audit.jsonl"] as const;

interface ArchiveFile {
  path: string;
  size: number;
  sha256: string;
  content: string;
}
interface Archive {
  format: "wisp-transfer";
  version: 1;
  id: string;
  kind: "migration" | "backup";
  createdAt: string;
  timeZone: string;
  records: ConversationRecord[];
  files: ArchiveFile[];
}
export interface TransferSummary {
  id: string;
  kind: "migration" | "backup";
  conversations: number;
  messages: number;
  files: number;
  bytes: number;
  dryRun: boolean;
}
interface TransferOptions {
  dryRun?: boolean;
  timeZone?: string;
}

function fail(message = "The transfer archive is invalid."): never {
  throw new HttpError(400, "invalid_request", message);
}
function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function validateRelative(value: string): string {
  if (
    !value ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail("Archive paths must remain inside the destination.");
  return value;
}
function allowedFile(value: string, kind: Archive["kind"]): boolean {
  return (
    ROOTS.some((root) => value.startsWith(`${root}/`)) ||
    (kind === "backup" ? BACKUP_FILES : SETTINGS).some((file) => file === value)
  );
}
function readBounded(file: string, maximum = MAX_ARCHIVE_BYTES): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) fail("Transfer input is not a bounded regular file.");
    const bytes = readFileSync(fd);
    if (bytes.length > maximum) fail("Transfer input exceeds the size limit.");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function readTransferKey(file: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    fail("The archive key must be a private regular file (0600 or 0400).");
  const key = readBounded(file, 32);
  if (key.length !== 32) fail("The archive key must contain exactly 32 bytes.");
  return key;
}

function filesIn(root: string, kind: Archive["kind"]): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  let total = 0;
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail("Symbolic links are not included in transfers.");
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) visit(relative ? `${relative}/${entry}` : entry);
      return;
    }
    validateRelative(relative);
    if (!stat.isFile() || !allowedFile(relative, kind)) fail("Unsupported file in transfer.");
    total += stat.size;
    if (files.length >= MAX_FILES || total > MAX_ARCHIVE_BYTES / 2)
      fail("The transfer exceeds the supported size or file count.");
    const bytes = readBounded(absolute);
    files.push({ path: relative, size: bytes.length, sha256: digest(bytes), content: bytes.toString("base64") });
  };
  for (const relative of [...ROOTS, ...(kind === "backup" ? BACKUP_FILES : SETTINGS)]) visit(relative);
  return files;
}

function portableSessionFile(root: string, record: ConversationRecord): string | null {
  if (!record.piSessionFile) return null;
  if (!record.sessionId) fail();
  const relative = path.relative(realpathSync(root), realpathSync(record.piSessionFile)).split(path.sep).join("/");
  validateRelative(relative);
  if (!relative.startsWith(`pi-sessions/${record.sessionId}/`))
    fail("Session files must belong to their conversation.");
  return relative;
}

function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) fail("The archive timezone is invalid.");
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return fail("The archive timezone is invalid.");
  }
}

function normalizeRecords(raw: unknown, portable = true): ConversationRecord[] {
  if (!Array.isArray(raw) || raw.length > 1000) fail();
  const seen = new Set<string>();
  const sessions = new Set<string>();
  const records = raw.map((value): ConversationRecord => {
    if (!value || typeof value !== "object") fail();
    if (!value.chat || typeof value.chat !== "object" || !Array.isArray(value.chat.messages)) fail();
    // The desktop's 10,000-message blob limit does not apply to paginated SQL history.
    const chat = normalizeChat({ ...value.chat, messages: [] });
    let messageBytes = 0;
    const messageIds = new Set<string>();
    chat.messages = value.chat.messages.map((rawMessage: unknown, index: number) => {
      const message = normalizeMessage(rawMessage, `${chat.id}:message:${index}`, 500_000);
      if (messageIds.has(message.id!)) fail("Duplicate message identity in archive.");
      messageIds.add(message.id!);
      messageBytes += Buffer.byteLength(JSON.stringify(message));
      if (messageBytes > MAX_ARCHIVE_BYTES / 4) fail("The history exceeds the supported archive size.");
      return message;
    });
    if (seen.has(chat.id)) fail("Duplicate conversation identity in archive.");
    seen.add(chat.id);
    const sessionId = value.sessionId === null ? null : normalizeConversationId(value.sessionId);
    if ((chat.kind === "wisp") !== (sessionId !== null)) fail();
    if (sessionId && sessions.has(sessionId)) fail("Two conversations cannot own the same session.");
    if (sessionId) sessions.add(sessionId);
    for (const key of ["createdAt", "updatedAt"])
      if (typeof value[key] !== "string" || value[key].length > 100 || !Number.isFinite(Date.parse(value[key]))) fail();
    let piSessionFile: string | null = typeof value.piSessionFile === "string" ? value.piSessionFile : null;
    if (piSessionFile && portable) {
      piSessionFile = validateRelative(piSessionFile);
      if (!sessionId || !piSessionFile.startsWith(`pi-sessions/${sessionId}/`)) fail();
    }
    if (
      chat.messages.some(
        (message) => "status" in message && (message.status === "queued" || message.status === "streaming"),
      )
    )
      fail("Finish or cancel active work before exporting conversations.");
    return {
      chat,
      sessionId,
      piSessionId: typeof value.piSessionId === "string" ? normalizeConversationId(value.piSessionId) : null,
      piSessionFile,
      modelOverride: normalizeSelection(value.modelOverride),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  });
  validateConversationGraph(Object.fromEntries(records.map((record) => [record.chat.id, record.chat])));
  return records;
}

function encode(archive: Archive, key: Buffer): Buffer {
  if (key.length !== 32) fail("The archive key must contain exactly 32 bytes.");
  const plain = Buffer.from(JSON.stringify(archive));
  if (plain.length > MAX_ARCHIVE_BYTES) fail("The archive exceeds its size limit.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

function decode(file: string, key: Buffer): Archive {
  const data = readBounded(file);
  if (key.length !== 32 || !data.subarray(0, MAGIC.length).equals(MAGIC) || data.length < MAGIC.length + 28) fail();
  let raw: unknown;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(data.subarray(MAGIC.length + 12, MAGIC.length + 28));
    const compressed = Buffer.concat([decipher.update(data.subarray(MAGIC.length + 28)), decipher.final()]);
    raw = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES }).toString("utf8"));
  } catch {
    fail("The archive is damaged or its key is incorrect.");
  }
  if (!raw || typeof raw !== "object") fail();
  const candidate = raw as Partial<Archive>;
  if (
    candidate.format !== "wisp-transfer" ||
    candidate.version !== 1 ||
    !["migration", "backup"].includes(candidate.kind ?? "") ||
    typeof candidate.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(candidate.id) ||
    typeof candidate.createdAt !== "string" ||
    !Array.isArray(candidate.files) ||
    candidate.files.length > MAX_FILES
  )
    fail();
  const kind = candidate.kind as Archive["kind"];
  const paths = new Set<string>();
  let size = 0;
  for (const entry of candidate.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.content !== "string" ||
      typeof entry.sha256 !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      fail();
    validateRelative(entry.path);
    if (!allowedFile(entry.path, kind) || paths.has(entry.path)) fail("Unexpected or duplicate file in archive.");
    paths.add(entry.path);
    const content = Buffer.from(entry.content, "base64");
    size += content.length;
    if (
      size > MAX_ARCHIVE_BYTES / 2 ||
      content.toString("base64") !== entry.content ||
      content.length !== entry.size ||
      digest(content) !== entry.sha256
    )
      fail("Archive checksum or size validation failed.");
  }
  const records = normalizeRecords(candidate.records);
  for (const record of records)
    if (record.piSessionFile && !paths.has(record.piSessionFile)) fail("A referenced Pi session file is missing.");
  if (kind === "backup" && !paths.has("wisp.sqlite")) fail("The backup has no database.");
  return {
    format: "wisp-transfer",
    version: 1,
    id: candidate.id,
    kind,
    createdAt: candidate.createdAt,
    timeZone: normalizeTimeZone(candidate.timeZone),
    records,
    files: candidate.files,
  };
}

function summarize(archive: Archive, dryRun: boolean): TransferSummary {
  return {
    id: archive.id,
    kind: archive.kind,
    conversations: archive.records.length,
    messages: archive.records.reduce((sum, record) => sum + record.chat.messages.length, 0),
    files: archive.files.length,
    bytes: archive.files.reduce((sum, file) => sum + file.size, 0),
    dryRun,
  };
}
function output(archive: Archive, file: string, key: Buffer, options: TransferOptions): TransferSummary {
  const bytes = encode(archive, key);
  if (!options.dryRun) writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return summarize(archive, Boolean(options.dryRun));
}
function archive(
  kind: Archive["kind"],
  records: ConversationRecord[],
  files: ArchiveFile[],
  timeZone: string,
): Archive {
  return {
    format: "wisp-transfer",
    version: 1,
    id: randomUUID(),
    kind,
    createdAt: new Date().toISOString(),
    timeZone: normalizeTimeZone(timeZone),
    records,
    files,
  };
}

/** The local desktop must be closed before this offline export. The source is read-only. */
export function createLocalMigration(
  sourceDirectory: string,
  outputFile: string,
  key: Buffer,
  options: TransferOptions = {},
): TransferSummary {
  const root = realpathSync(sourceDirectory);
  const file = path.join(root, "conversations.json");
  const before = readBounded(file, 32 * 1024 * 1024);
  const raw = JSON.parse(before.toString("utf8")) as {
    schemaVersion?: number;
    conversations?: Record<string, unknown>;
  };
  if (
    ![1, 2, 3, 4].includes(raw.schemaVersion ?? 0) ||
    !raw.conversations ||
    typeof raw.conversations !== "object" ||
    Array.isArray(raw.conversations)
  )
    fail("The local conversation store is invalid.");
  const records = normalizeRecords(Object.values(raw.conversations), false).map((record) => ({
    ...record,
    piSessionFile: portableSessionFile(root, record),
  }));
  const files = filesIn(root, "migration");
  if (!readBounded(file).equals(before)) fail("The local store changed during export. Close the desktop and retry.");
  for (const record of records)
    if (record.piSessionFile && !files.some((entry) => entry.path === record.piSessionFile))
      fail("A referenced Pi session is missing.");
  return output(
    archive("migration", records, files, options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    outputFile,
    key,
    options,
  );
}

function serverRecords(database: ServerDatabase): ConversationRecord[] {
  const size = database.sql.prepare("SELECT COALESCE(SUM(length(message)),0) AS bytes FROM messages").get()?.bytes;
  if (Number(size) > MAX_ARCHIVE_BYTES / 4) fail("The history exceeds the supported archive size.");
  return normalizeRecords(
    database.sql
      .prepare("SELECT record FROM conversations ORDER BY id")
      .all()
      .map((row) => {
        const record = JSON.parse(row.record as string) as ConversationRecord;
        record.chat.messages = database.sql
          .prepare("SELECT message FROM messages WHERE conversation_id=? ORDER BY ordinal")
          .all(record.chat.id)
          .map((message) => JSON.parse(message.message as string));
        record.piSessionFile = portableSessionFile(database.directory, record);
        return record;
      }),
  );
}

function requireQuiescence(database: ServerDatabase): void {
  if (
    Number(
      database.sql.prepare("SELECT COUNT(*) AS count FROM requests WHERE status IN ('queued','running')").get()?.count,
    )
  )
    fail("Wait for all work to finish before transferring the instance.");
}

function migrationFiles(database: ServerDatabase): ArchiveFile[] {
  const files = filesIn(database.directory, "migration").filter(
    (file) => !["ai-settings.json", "tool-policy.json"].includes(file.path),
  );
  for (const [name, value] of [
    ["ai-settings.json", { schemaVersion: 1, selection: JSON.parse(database.getMeta("modelSelection") ?? "null") }],
    ["tool-policy.json", JSON.parse(database.getMeta("toolPolicy") ?? '{"autoReview":true,"rules":[]}')],
  ] as const) {
    const bytes = Buffer.from(JSON.stringify(value));
    files.push({ path: name, size: bytes.length, sha256: digest(bytes), content: bytes.toString("base64") });
  }
  return files;
}

function importedSettings(bundle: Archive): { model?: string; policy?: string } {
  const result: { model?: string; policy?: string } = {};
  for (const file of bundle.files) {
    if (file.path === "ai-settings.json") {
      const raw = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      const selection = normalizeSelection(raw.selection);
      if (raw.schemaVersion !== 1 || (raw.selection !== null && !selection)) fail("The model settings are invalid.");
      result.model = JSON.stringify(selection);
    } else if (file.path === "tool-policy.json") {
      result.policy = JSON.stringify(
        normalizeToolPolicy(JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))),
      );
    }
  }
  return result;
}

/** Must be invoked by the administrative maintenance operation, never while accepting commands. */
export function exportServerMigration(
  database: ServerDatabase,
  outputFile: string,
  key: Buffer,
  options: TransferOptions = {},
): TransferSummary {
  requireQuiescence(database);
  return output(
    archive("migration", serverRecords(database), migrationFiles(database), database.getMeta("timeZone") ?? "UTC"),
    outputFile,
    key,
    options,
  );
}

export function exportServerBackup(
  database: ServerDatabase,
  outputFile: string,
  key: Buffer,
  options: TransferOptions = {},
): TransferSummary {
  requireQuiescence(database);
  database.checkpoint();
  return output(
    archive(
      "backup",
      serverRecords(database),
      filesIn(database.directory, "backup"),
      database.getMeta("timeZone") ?? "UTC",
    ),
    outputFile,
    key,
    options,
  );
}

function remapSession(bytes: Buffer, relative: string, destination: string): Buffer {
  if (!relative.startsWith("pi-sessions/") || !relative.endsWith(".jsonl")) return bytes;
  const sessionId = relative.split("/")[1]!;
  const lines = bytes
    .toString("utf8")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      // Rewrite structured session metadata only, never text in messages or tool outputs.
      return entry.type === "session"
        ? JSON.stringify({ ...entry, cwd: path.join(destination, "workspaces", sessionId) })
        : line;
    });
  return Buffer.from(lines.join("\n"));
}

function materialize(bundle: Archive, staging: string, finalDirectory: string): void {
  for (const entry of bundle.files) {
    const target = path.join(staging, validateRelative(entry.path));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const fd = openSync(target, "wx", 0o600);
    try {
      writeFileSync(fd, remapSession(Buffer.from(entry.content, "base64"), entry.path, finalDirectory));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(path.dirname(target));
  }
}

const IMPORT_JOURNAL = ".import-journal.json";
const IMPORT_ROOTS = new Set<string>([...ROOTS, ...SETTINGS]);
interface ImportJournal {
  archiveId: string;
  staging: string;
  roots: string[];
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeImportJournal(database: ServerDatabase, journal: ImportJournal): void {
  const target = path.join(database.directory, IMPORT_JOURNAL);
  if (existsSync(target)) fail("An import recovery journal already exists. Restart this instance before importing.");
  const temporary = path.join(database.directory, `.import-journal-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(journal));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    syncDirectory(database.directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Run after obtaining the instance lock, before loading its runtime or accepting commands. */
export function recoverInterruptedImport(database: ServerDatabase): void {
  const journalPath = path.join(database.directory, IMPORT_JOURNAL);
  if (!existsSync(journalPath)) return;
  let journal: ImportJournal;
  try {
    journal = JSON.parse(readBounded(journalPath, 16 * 1024).toString("utf8")) as ImportJournal;
  } catch {
    return fail("The import recovery journal is invalid. Inspect it before starting this instance.");
  }
  if (
    !journal ||
    typeof journal !== "object" ||
    typeof journal.archiveId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(journal.archiveId) ||
    typeof journal.staging !== "string" ||
    !/^\.import-[A-Za-z0-9_-]{6,64}$/.test(journal.staging) ||
    !Array.isArray(journal.roots) ||
    journal.roots.length > IMPORT_ROOTS.size ||
    new Set(journal.roots).size !== journal.roots.length ||
    journal.roots.some((root) => typeof root !== "string" || !IMPORT_ROOTS.has(root))
  )
    fail("The import recovery journal contains invalid paths.");
  const committed = database.getMeta(`import:${journal.archiveId}`) !== null;
  if (!committed && Number(database.sql.prepare("SELECT COUNT(*) AS count FROM conversations").get()?.count))
    fail("An interrupted import conflicts with existing conversations. Inspect the instance before recovery.");
  const staging = path.join(database.directory, journal.staging);
  const candidates = [staging, ...(!committed ? journal.roots.map((root) => path.join(database.directory, root)) : [])];
  // Validate every cleanup target before removing any. Only fixed root names and
  // a generated direct-child staging basename can come from the journal.
  for (const target of candidates)
    if (existsSync(target) && lstatSync(target).isSymbolicLink())
      fail("Import recovery refuses symbolic links. Inspect the instance before recovery.");
  for (const target of candidates) rmSync(target, { recursive: true, force: true });
  unlinkSync(journalPath);
  syncDirectory(database.directory);
}

export function importMigration(
  database: ServerDatabase,
  repository: SqliteConversationRepository,
  inputFile: string,
  key: Buffer,
  options: TransferOptions = {},
): TransferSummary {
  requireQuiescence(database);
  const bundle = decode(inputFile, key);
  if (bundle.kind !== "migration") fail("Use restore for a full instance backup.");
  const settings = importedSettings(bundle);
  const destinationTimeZone = database.getMeta("timeZone");
  if (destinationTimeZone && normalizeTimeZone(destinationTimeZone) !== bundle.timeZone)
    fail(
      `The archive timezone is ${bundle.timeZone}. Start an empty destination with --time-zone ${bundle.timeZone} before importing; no data was changed.`,
    );
  const previous = database.getMeta(`import:${bundle.id}`);
  if (previous) fail("This archive has already been imported.");
  if (Number(database.sql.prepare("SELECT COUNT(*) AS count FROM conversations").get()?.count))
    fail("Migration requires an empty destination instance.");
  const destinations = [...new Set(bundle.files.map((file) => file.path.split("/")[0]!))];
  for (const name of destinations) {
    const destination = path.join(database.directory, name);
    if (existsSync(destination) && (!lstatSync(destination).isDirectory() || readdirSync(destination).length))
      fail("Migration would replace existing files or settings; use an empty instance.");
  }
  if (options.dryRun) return summarize(bundle, true);
  const staging = mkdtempSync(path.join(database.directory, ".import-"));
  let journalWritten = false;
  try {
    writeImportJournal(database, { archiveId: bundle.id, staging: path.basename(staging), roots: destinations });
    journalWritten = true;
    materialize(bundle, staging, database.directory);
    for (const name of destinations) {
      const target = path.join(database.directory, name);
      if (existsSync(target)) rmdirSync(target);
      renameSync(path.join(staging, name), target);
      syncDirectory(database.directory);
    }
    database.transaction(() => {
      // Wisps precede circles so membership validation sees its referenced conversations.
      for (const record of [...bundle.records].sort(
        (a, b) => Number(a.chat.kind === "circle") - Number(b.chat.kind === "circle"),
      )) {
        repository.importRecord({
          ...record,
          piSessionFile: record.piSessionFile ? path.join(database.directory, record.piSessionFile) : null,
        });
      }
      database.setMeta(`import:${bundle.id}`, new Date().toISOString());
      database.setMeta("timeZone", bundle.timeZone);
      if (settings.model !== undefined) database.setMeta("modelSelection", settings.model);
      if (settings.policy !== undefined) database.setMeta("toolPolicy", settings.policy);
      database.setMeta("settingsRevision", String(Number(database.getMeta("settingsRevision") ?? 0) + 1));
      database.invalidateCursors();
      database.appendEvent("state_changed", {});
    });
    recoverInterruptedImport(database);
    return summarize(bundle, false);
  } catch (error) {
    if (journalWritten) recoverInterruptedImport(database);
    throw error;
  } finally {
    if (!journalWritten) rmSync(staging, { recursive: true, force: true });
  }
}

/** Restores offline into a new directory. Existing instances are never overwritten. */
export function restoreBackup(
  inputFile: string,
  targetDirectory: string,
  key: Buffer,
  options: TransferOptions = {},
): TransferSummary {
  const target = path.resolve(targetDirectory);
  if (existsSync(target)) fail("Restore requires a new destination directory.");
  const bundle = decode(inputFile, key);
  if (bundle.kind !== "backup") fail("Use import for a migration archive.");
  if (!options.dryRun) mkdirSync(path.dirname(target), { recursive: true });
  const staging = mkdtempSync(path.join(options.dryRun ? tmpdir() : path.dirname(target), ".wisp-restore-"));
  try {
    materialize(bundle, staging, target);
    const restored = new DatabaseSync(path.join(staging, "wisp.sqlite"));
    try {
      if (restored.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        fail("The restored database failed its integrity check.");
      if (restored.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value !== "1")
        fail("Unsupported backup schema.");
      const databaseRecords = restored.prepare("SELECT id,record,revision FROM conversations ORDER BY id").all();
      if (databaseRecords.length !== bundle.records.length) fail("The backup database and its manifest disagree.");
      if (restored.prepare("PRAGMA foreign_key_check").all().length)
        fail("The backup contains invalid database references.");
      const manifest = new Map(bundle.records.map((record) => [record.chat.id, record]));
      const rawRecords = databaseRecords.map((row) => {
        const expected = manifest.get(String(row.id));
        if (!expected || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1)
          fail("The backup database and its manifest disagree.");
        const stored = JSON.parse(row.record as string) as ConversationRecord;
        if (stored.chat?.id !== row.id || !Array.isArray(stored.chat.messages) || stored.chat.messages.length !== 0)
          fail("The backup metadata is invalid.");
        const messageRows = restored
          .prepare("SELECT id,message FROM messages WHERE conversation_id=? ORDER BY ordinal")
          .all(row.id!);
        stored.chat.messages = messageRows.map((messageRow) => {
          const message = normalizeMessage(JSON.parse(messageRow.message as string), undefined, 500_000);
          if (message.id !== messageRow.id) fail("The backup message identity is invalid.");
          return message;
        });
        return stored;
      });
      const normalized = normalizeRecords(rawRecords, false);
      const messageCount = normalized.reduce((sum, record) => sum + record.chat.messages.length, 0);
      if (Number(restored.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count) !== messageCount)
        fail("The backup contains messages outside its conversation manifest.");
      for (const record of normalized) {
        const expected = manifest.get(record.chat.id)!;
        if (
          record.piSessionFile !== null &&
          (!expected.piSessionFile ||
            !record.piSessionFile.endsWith(`${path.sep}${expected.piSessionFile.split("/").join(path.sep)}`))
        )
          fail("The backup session paths disagree with its manifest.");
        const comparable = { ...record, piSessionFile: record.piSessionFile === null ? null : expected.piSessionFile };
        if (JSON.stringify(comparable) !== JSON.stringify(expected))
          fail("The backup database and its manifest disagree.");
      }
      const storedTimeZone = restored.prepare("SELECT value FROM metadata WHERE key='timeZone'").get()?.value;
      if (storedTimeZone && normalizeTimeZone(storedTimeZone) !== bundle.timeZone)
        fail("The backup timezone disagrees with its manifest.");
      restored.exec("BEGIN IMMEDIATE");
      for (const record of bundle.records) {
        const metadata = {
          ...record,
          chat: { ...record.chat, messages: [] },
          piSessionFile: record.piSessionFile ? path.join(target, record.piSessionFile) : null,
        };
        restored.prepare("UPDATE conversations SET record=? WHERE id=?").run(JSON.stringify(metadata), record.chat.id);
      }
      restored
        .prepare(
          "INSERT INTO metadata(key,value) VALUES ('timeZone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(bundle.timeZone);
      restored.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(randomUUID());
      // Restored copies must be paired again; never resurrect revoked credentials from old backups.
      restored.exec(
        "UPDATE devices SET revoked=1; DELETE FROM tokens; DELETE FROM pairing; UPDATE approvals SET state='expired' WHERE state='pending'; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);",
      );
    } finally {
      restored.close();
    }
    if (options.dryRun) rmSync(staging, { recursive: true, force: true });
    else {
      renameSync(staging, target);
      syncDirectory(path.dirname(target));
    }
    return summarize(bundle, Boolean(options.dryRun));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
