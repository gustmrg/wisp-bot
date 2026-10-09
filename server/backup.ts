import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/**
 * Backups of one Wisp environment: a server's data directory, or the desktop
 * app's own. An archive is a gzip stream of entries encrypted with
 * AES-256-GCM under a separate 32-byte key:
 *
 *   "WISPBAK1" | nonce (12 bytes) | ciphertext | auth tag (16 bytes)
 *
 * The plaintext is JSON entry headers, one per line, each file header followed
 * by exactly `size` bytes. The tag authenticates everything, so a restore
 * writes into a temporary directory and keeps it only once the tag verifies.
 */
const MAGIC = Buffer.from("WISPBAK1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 1;
const MAX_HEADER_BYTES = 64 * 1024;

/** What an environment is made of; everything else (logs, caches, locks, sockets, app windows) is left out. */
const ROOTS = ["backend", "server.sqlite", "local-server-key.json"];
/** SQLite databases, copied through SQLite's backup API so a running server's copy is consistent. */
const DATABASES = new Set(["server.sqlite", "backend/conversations.sqlite"]);
const SKIPPED_DIRECTORIES = new Set(["backend/logs"]);
/** Each Wisp's cache of image transcriptions: text from the user's documents that can be rebuilt. */
const SKIPPED_DIRECTORY_PATTERNS = [/^backend\/pi-config\/[^/]+\/transcription-cache$/u];
const SKIPPED_SUFFIXES = ["-wal", "-shm", "-journal", ".tmp", ".keychain-backup", ".partial"];

export interface BackupManifest {
  format: typeof FORMAT;
  createdAt: string;
  appVersion: string;
  /** The server identity, when the environment has one. */
  serverId?: string;
}

export interface BackupSummary {
  manifest: BackupManifest;
  files: number;
  bytes: number;
  /** Links and special files are not followed or copied. */
  skipped: string[];
}

type Entry =
  | ({ type: "manifest" } & BackupManifest)
  | { type: "file"; path: string; size: number; mode: number }
  | { type: "end"; files: number; bytes: number };

export class BackupError extends Error {
  override name = "BackupError";
}

/**
 * Writes an encrypted archive of `dataDirectory` to `output`, which must not
 * exist. Files are read as they are; callers make sure no Wisp is working.
 */
export async function createBackup(options: {
  dataDirectory: string;
  output: string;
  key: Buffer;
  appVersion: string;
}): Promise<BackupSummary> {
  const { dataDirectory, output, key } = options;
  assertKey(key);
  await assertMissing(output, "The backup file already exists. Choose a new name.");
  const snapshots = await mkdtemp(path.join(path.dirname(output), ".wisp-backup-"));
  const partial = `${output}.partial`;
  try {
    const files = await collectFiles(dataDirectory);
    const snapshotOf = new Map<string, string>();
    for (const relative of files.paths.filter((candidate) => DATABASES.has(candidate))) {
      const target = path.join(snapshots, `${snapshotOf.size}.sqlite`);
      const source = new DatabaseSync(path.join(dataDirectory, relative), { readOnly: true });
      try {
        await backupDatabase(source, target);
      } finally {
        source.close();
      }
      snapshotOf.set(relative, target);
    }
    const manifest: BackupManifest = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      appVersion: options.appVersion,
      ...(await serverIdOf(snapshotOf.get("server.sqlite"))),
    };
    let bytes = 0;
    async function* entries(): AsyncGenerator<Buffer> {
      yield line({ type: "manifest", ...manifest });
      for (const relative of files.paths) {
        const source = snapshotOf.get(relative) ?? path.join(dataDirectory, relative);
        const info = await stat(source);
        yield line({ type: "file", path: relative, size: info.size, mode: info.mode & 0o777 });
        let read = 0;
        if (info.size > 0) {
          for await (const chunk of createReadStream(source, { end: info.size - 1 })) {
            read += (chunk as Buffer).length;
            yield chunk as Buffer;
          }
        }
        if (read !== info.size) {
          throw new BackupError(`${relative} changed while it was being backed up. Try again.`);
        }
        bytes += info.size;
      }
      yield line({ type: "end", files: files.paths.length, bytes });
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(MAGIC);
    const file = createWriteStream(partial, { flags: "wx", mode: 0o600 });
    file.write(Buffer.concat([MAGIC, nonce]));
    await pipeline(Readable.from(entries()), createGzip(), cipher, file, { end: false });
    await new Promise<void>((resolve, reject) => {
      file.end(cipher.getAuthTag(), () => resolve());
      file.once("error", reject);
    });
    await syncFile(partial);
    await rename(partial, output);
    return { manifest, files: files.paths.length, bytes, skipped: files.skipped };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    await rm(snapshots, { recursive: true, force: true });
  }
}

/**
 * Restores an archive into `target`, which must not exist or be empty. Nothing
 * appears in `target` unless the whole archive is authentic and complete.
 */
export async function restoreBackup(options: { input: string; key: Buffer; target: string }): Promise<BackupSummary> {
  const target = path.resolve(options.target);
  await assertEmptyOrMissing(target);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.restoring-`);
  try {
    const summary = await readArchive(options.input, options.key, staging);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return summary;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Reads a whole archive without writing anything, to check the key and its integrity. */
export function verifyBackup(options: { input: string; key: Buffer }): Promise<BackupSummary> {
  return readArchive(options.input, options.key, undefined);
}

async function readArchive(input: string, key: Buffer, destination: string | undefined): Promise<BackupSummary> {
  assertKey(key);
  const handle = await open(input, "r");
  let size: number;
  let nonce: Buffer;
  let tag: Buffer;
  try {
    size = (await handle.stat()).size;
    if (size < MAGIC.length + NONCE_BYTES + TAG_BYTES) throw new BackupError("This is not a Wisp backup.");
    const head = Buffer.alloc(MAGIC.length + NONCE_BYTES);
    await handle.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("This is not a Wisp backup.");
    nonce = head.subarray(MAGIC.length);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const parser = new ArchiveParser(destination);
  try {
    await pipeline(
      createReadStream(input, { start: MAGIC.length + NONCE_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createGunzip(),
      parser,
    );
  } catch (error) {
    if (error instanceof BackupError) throw error;
    // A wrong key, a changed byte, or a cut-off file all fail authentication or decompression.
    throw new BackupError("The backup cannot be read with this key, or it is damaged.");
  }
  return parser.summary();
}

/** Consumes the decrypted entry stream, writing files under `destination` when given. */
class ArchiveParser extends Writable {
  private buffer: Buffer = Buffer.alloc(0);
  private manifest: BackupManifest | undefined;
  private current:
    | { path: string; size: number; remaining: number; file?: PassThrough; done?: Promise<void> }
    | undefined;
  private files = 0;
  private bytes = 0;
  private ended = false;
  private readonly seen = new Set<string>();

  constructor(private readonly destination: string | undefined) {
    super();
  }

  summary(): BackupSummary {
    if (!this.manifest || !this.ended) throw new BackupError("The backup is incomplete.");
    return { manifest: this.manifest, files: this.files, bytes: this.bytes, skipped: [] };
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.drain().then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.current || this.buffer.length > 0 || !this.ended) callback(new BackupError("The backup is incomplete."));
    else callback();
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      if (this.current) {
        const take = Math.min(this.current.remaining, this.buffer.length);
        const piece = this.buffer.subarray(0, take);
        this.buffer = this.buffer.subarray(take);
        this.current.remaining -= take;
        if (this.current.file && !this.current.file.write(piece)) {
          await new Promise((resolve) => this.current?.file?.once("drain", resolve));
        }
        if (this.current.remaining === 0) await this.finishFile();
        continue;
      }
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) throw new BackupError("The backup is damaged.");
        return;
      }
      const entry = parseEntry(this.buffer.subarray(0, newline));
      this.buffer = this.buffer.subarray(newline + 1);
      await this.begin(entry);
    }
  }

  private async begin(entry: Entry): Promise<void> {
    if (this.ended) throw new BackupError("The backup is damaged.");
    if (entry.type === "manifest") {
      if (this.manifest || entry.format !== FORMAT) throw new BackupError("This backup format is not supported.");
      const { type: _type, ...manifest } = entry;
      this.manifest = manifest;
      return;
    }
    if (!this.manifest) throw new BackupError("The backup is damaged.");
    if (entry.type === "end") {
      if (entry.files !== this.files || entry.bytes !== this.bytes) throw new BackupError("The backup is incomplete.");
      this.ended = true;
      return;
    }
    const relative = safeRelativePath(entry.path);
    if (this.seen.has(relative)) throw new BackupError("The backup is damaged.");
    this.seen.add(relative);
    this.current = { path: relative, size: entry.size, remaining: entry.size };
    if (this.destination) {
      const target = path.join(this.destination, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const file = new PassThrough();
      this.current.file = file;
      this.current.done = pipeline(file, createWriteStream(target, { flags: "wx", mode: entry.mode & 0o700 || 0o600 }));
    }
    if (entry.size === 0) await this.finishFile();
  }

  private async finishFile(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    current.file?.end();
    await current.done;
    this.files++;
    this.bytes += current.size;
  }
}

function parseEntry(raw: Buffer): Entry {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BackupError("The backup is damaged.");
  }
  const entry = value as Partial<Entry> & Record<string, unknown>;
  if (entry.type === "file") {
    if (
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      !Number.isInteger(entry.mode)
    ) {
      throw new BackupError("The backup is damaged.");
    }
    return entry as Entry;
  }
  if (entry.type === "manifest" || entry.type === "end") return entry as Entry;
  throw new BackupError("The backup is damaged.");
}

/** Archive paths are relative, forward-slashed, and never leave the restored directory. */
function safeRelativePath(value: string): string {
  const parts = value.split("/");
  if (
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    !ROOTS.includes(parts[0] ?? "")
  ) {
    throw new BackupError("The backup contains an unsafe path.");
  }
  return parts.join(path.sep);
}

async function collectFiles(dataDirectory: string): Promise<{ paths: string[]; skipped: string[] }> {
  const paths: string[] = [];
  const skipped: string[] = [];
  async function visit(relative: string): Promise<void> {
    if (
      SKIPPED_DIRECTORIES.has(relative) ||
      SKIPPED_DIRECTORY_PATTERNS.some((pattern) => pattern.test(relative)) ||
      SKIPPED_SUFFIXES.some((suffix) => relative.endsWith(suffix))
    ) {
      return;
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path.join(dataDirectory, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isDirectory()) {
      const children = (await readdir(path.join(dataDirectory, relative))).sort();
      for (const child of children) await visit(`${relative}/${child}`);
    } else if (info.isFile()) {
      paths.push(relative);
    } else {
      skipped.push(relative);
    }
  }
  for (const root of ROOTS) await visit(root);
  if (!paths.some((candidate) => candidate.startsWith("backend/"))) {
    throw new BackupError(`${dataDirectory} does not contain Wisp data.`);
  }
  return { paths, skipped };
}

async function serverIdOf(snapshot: string | undefined): Promise<{ serverId?: string }> {
  if (!snapshot) return {};
  const database = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key = 'serverId'").get() as
      | { value: string }
      | undefined;
    return row ? { serverId: row.value } : {};
  } finally {
    database.close();
  }
}

function line(entry: Entry): Buffer {
  return Buffer.from(`${JSON.stringify(entry)}\n`);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new BackupError("The backup key must contain exactly 32 bytes.");
}

async function assertMissing(file: string, message: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new BackupError(message);
}

async function assertEmptyOrMissing(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length === 0) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new BackupError(`${directory} is a file.`);
    throw error;
  }
  throw new BackupError(`${directory} is not empty. Restore into a new directory.`);
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
