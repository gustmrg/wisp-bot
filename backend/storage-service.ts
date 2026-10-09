import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  ARCHIVE_MANIFEST_FILE,
  MAX_ARCHIVE_DELETIONS,
  MAX_CLEANUP_PATHS,
  STORAGE_PAGE_SIZE,
  type ArchiveManifest,
  type StorageArchive,
  type StorageArchiveDeletionRequest,
  type StorageArchiveDeletionResult,
  type StorageCleanupConfirmation,
  type StorageCleanupPreview,
  type StorageCleanupRequest,
  type StorageCleanupResult,
  type StorageDirectoryPage,
  type StorageDirectoryRequest,
  type StorageEntry,
  type StorageEntryType,
  type StorageSummary,
  type StorageSummaryRequest,
  type StorageWorkspace,
} from "../shared/storage.js";
import { WORKSPACE_INBOX_DIRECTORY, WORKSPACE_QUOTA_BYTES } from "../shared/workspace.js";
import { WispBackendError } from "./backend-error.js";
import { measureTree } from "./workspace-service.js";

/** How long a measurement is reused before the next summary measures again. */
const SUMMARY_TTL_MS = 30_000;
const MEASURE_CONCURRENCY = 4;

async function mapLimited<T, R>(items: ReadonlyArray<T>, limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface StorageServiceOptions {
  /** Every conversation's workspace folder, once per conversation. */
  listWorkspaces: () => ReadonlyArray<{
    conversationId: string;
    name: string;
    kind: "wisp" | "circle";
    directory: string;
  }>;
  /** A conversation's workspace folder; throws for an unknown conversation. */
  resolveWorkspace: (conversationId: string) => string;
  archiveDirectory: string;
  /** Whether an agent is running or has work queued for the conversation. */
  isBusy: (conversationId: string) => boolean;
  /** Called after a cleanup ends, so requests held back meanwhile can run. */
  onCleanupFinished?: (conversationId: string) => void;
  quotaBytes?: number;
  now?: () => Date;
}

/**
 * Reports how much space workspaces and archived conversations take, lets the
 * person look inside a workspace, and deletes what they select. The renderer
 * only ever names conversations and workspace-relative paths; every path is
 * resolved and contained here.
 */
export class StorageService {
  private readonly options: StorageServiceOptions;
  private readonly quotaBytes: number;
  private cache: { summary: StorageSummary; at: number } | undefined;
  private readonly cleaning = new Set<string>();
  private readonly writers = new Map<string, number>();

  constructor(options: StorageServiceOptions) {
    this.options = options;
    this.quotaBytes = options.quotaBytes ?? WORKSPACE_QUOTA_BYTES;
  }

  /**
   * Held while files are written into a workspace (attachments, uploads). It
   * throws while a cleanup runs there; a cleanup refuses to start while any
   * write is held. Release drops the cached measurement.
   */
  acquireWrite(conversationId: string): () => void {
    if (this.cleaning.has(conversationId)) {
      throw new WispBackendError(
        "unavailable",
        "This workspace is being cleaned up. Try attaching the file again in a moment.",
        true,
      );
    }
    this.writers.set(conversationId, (this.writers.get(conversationId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.writers.get(conversationId) ?? 1) - 1;
      if (remaining > 0) this.writers.set(conversationId, remaining);
      else this.writers.delete(conversationId);
      this.cache = undefined;
    };
  }

  /** Whether files are being removed from the conversation's workspace; agents must not run meanwhile. */
  isCleaning(conversationId: string): boolean {
    return this.cleaning.has(conversationId);
  }

  async getSummary(request: StorageSummaryRequest = {}): Promise<StorageSummary> {
    const now = this.now();
    if (!request.refresh && this.cache && now.getTime() - this.cache.at < SUMMARY_TTL_MS) return this.cache.summary;
    const [workspaces, archives] = await Promise.all([this.measureWorkspaces(), this.measureArchives()]);
    const summary: StorageSummary = {
      measuredAt: this.now().toISOString(),
      workspaces,
      workspaceBytes: workspaces.reduce((sum, { usedBytes }) => sum + usedBytes, 0),
      archives,
      archiveBytes: archives.reduce((sum, { usedBytes }) => sum + usedBytes, 0),
      partial: [...workspaces, ...archives].some(({ partial }) => partial),
    };
    this.cache = { summary, at: now.getTime() };
    return summary;
  }

  private async measureWorkspaces(): Promise<StorageWorkspace[]> {
    // Each conversation has its own folder; should two records ever point at
    // the same one, it is measured and listed once rather than counted twice.
    const seen = new Set<string>();
    const unique = this.options.listWorkspaces().filter(({ directory }) => !seen.has(directory) && seen.add(directory));
    const measured = await mapLimited(unique, MEASURE_CONCURRENCY, async (workspace) => {
      const tree = await measureTree(workspace.directory);
      return {
        conversationId: workspace.conversationId,
        name: workspace.name,
        kind: workspace.kind,
        usedBytes: tree.bytes,
        fileCount: tree.files,
        quotaBytes: this.quotaBytes,
        partial: tree.partial,
      } satisfies StorageWorkspace;
    });
    return measured.sort((a, b) => b.usedBytes - a.usedBytes || a.name.localeCompare(b.name));
  }

  private async measureArchives(): Promise<StorageArchive[]> {
    let names: string[];
    try {
      names = (await readdir(this.options.archiveDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new WispBackendError("internal_error", "The archived conversations could not be read.", true);
    }
    const measured = await mapLimited(names, MEASURE_CONCURRENCY, async (id) => {
      const directory = path.join(this.options.archiveDirectory, id);
      const tree = await measureTree(directory);
      const info = await lstat(directory).catch(() => null);
      const manifest = await readArchiveManifest(directory);
      return {
        id,
        name: manifest?.name ?? null,
        kind: manifest?.kind ?? null,
        usedBytes: tree.bytes,
        fileCount: tree.files,
        // Archives made before the manifest fall back to the folder's own timestamp.
        archivedAt: manifest?.archivedAt || (info ? info.mtime.toISOString() : null),
        partial: tree.partial || !info,
      } satisfies StorageArchive;
    });
    return measured.sort((a, b) => b.usedBytes - a.usedBytes || a.id.localeCompare(b.id));
  }

  async listDirectory(request: StorageDirectoryRequest): Promise<StorageDirectoryPage> {
    const root = this.options.resolveWorkspace(request.conversationId);
    const segments = parseRelativePath(request.path, true);
    const directory = await resolveFolder(root, segments);
    if (directory === null) return { path: segments.join("/"), entries: [], nextCursor: null };
    const offset = parseCursor(request.cursor);
    const entries = await readEntries(directory, segments);
    entries.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    const page = entries.slice(offset, offset + STORAGE_PAGE_SIZE);
    return {
      path: segments.join("/"),
      entries: page,
      nextCursor: offset + page.length < entries.length ? String(offset + page.length) : null,
    };
  }

  /** What deleting these paths would remove, measured now. Nothing is deleted. */
  async prepareCleanup(request: StorageCleanupRequest): Promise<StorageCleanupPreview> {
    const root = this.options.resolveWorkspace(request.conversationId);
    const items = await inspectTargets(root, request.paths);
    return {
      items,
      totalBytes: items.reduce((sum, { size }) => sum + size, 0),
      fileCount: items.reduce((sum, { fileCount }) => sum + fileCount, 0),
      fingerprint: fingerprintOf(items),
      includesInbox: items.some(({ path: itemPath }) => isInside(itemPath, WORKSPACE_INBOX_DIRECTORY)),
    };
  }

  /**
   * Permanently deletes the previewed paths. Refuses while the conversation is
   * working or receiving files, and when anything differs from the preview.
   */
  async cleanup(request: StorageCleanupConfirmation): Promise<StorageCleanupResult> {
    const { conversationId } = request;
    const root = this.options.resolveWorkspace(conversationId);
    if (this.options.isBusy(conversationId) || this.writers.has(conversationId) || this.cleaning.has(conversationId)) {
      throw new WispBackendError(
        "unavailable",
        "This workspace is in use right now. Wait for the Wisp to finish and try again.",
        true,
      );
    }
    this.cleaning.add(conversationId);
    try {
      const items = await inspectTargets(root, request.paths);
      if (fingerprintOf(items) !== request.fingerprint) {
        throw new WispBackendError(
          "invalid_request",
          "These files changed after the preview. Review the selection and confirm again.",
        );
      }
      const removed: string[] = [];
      const failed: Array<{ path: string; message: string }> = [];
      let removedBytes = 0;
      for (const item of items) {
        try {
          // Containment is checked again immediately before each removal.
          const target = await resolveTarget(root, parseRelativePath(item.path, false));
          await rm(target, { recursive: true, force: false });
          removed.push(item.path);
          removedBytes += item.size;
        } catch (error) {
          failed.push({ path: item.path, message: describeFailure(error) });
        }
      }
      return { removed, failed, removedBytes };
    } finally {
      this.cleaning.delete(conversationId);
      this.cache = undefined;
      this.options.onCleanupFinished?.(conversationId);
    }
  }

  /** Permanently deletes archived conversations, each as a whole. */
  async deleteArchives(request: StorageArchiveDeletionRequest): Promise<StorageArchiveDeletionResult> {
    if (!request.ids.length || request.ids.length > MAX_ARCHIVE_DELETIONS) {
      throw new WispBackendError("invalid_request", "Choose which archived conversations to delete.");
    }
    const removed: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    try {
      for (const id of new Set(request.ids)) {
        try {
          if (!isArchiveId(id)) throw new WispBackendError("invalid_request", "That archive does not exist.");
          const target = path.join(this.options.archiveDirectory, id);
          const info = await lstat(target);
          if (!info.isDirectory()) throw new WispBackendError("invalid_request", "That archive does not exist.");
          await rm(target, { recursive: true, force: false });
          removed.push(id);
        } catch (error) {
          failed.push({ id, message: describeFailure(error) });
        }
      }
    } finally {
      this.cache = undefined;
    }
    return { removed, failed };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof WispBackendError) return error.message;
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return "It was already gone.";
    case "EACCES":
    case "EPERM":
      return "Permission denied.";
    default:
      return "It could not be removed.";
  }
}

/** The archive's name and kind, or null when it has no readable manifest. */
async function readArchiveManifest(directory: string): Promise<ArchiveManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, ARCHIVE_MANIFEST_FILE), "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { name, kind, archivedAt } = value as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || (kind !== "wisp" && kind !== "circle")) return null;
    const time = typeof archivedAt === "string" && !Number.isNaN(Date.parse(archivedAt)) ? archivedAt : "";
    return { name: name.slice(0, 200), kind, archivedAt: time };
  } catch {
    return null;
  }
}

function isArchiveId(id: string): boolean {
  return id.length > 0 && id.length <= 255 && !/[\\/\0]/.test(id) && id !== "." && id !== "..";
}

function isInside(relativePath: string, folder: string): boolean {
  return relativePath === folder || relativePath.startsWith(`${folder}/`);
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new WispBackendError("invalid_request", "Invalid page.");
  return offset;
}

/** Splits a workspace-relative path, refusing anything that could leave the workspace. */
function parseRelativePath(value: string, allowRoot: boolean): string[] {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || value.includes("\\")) {
    throw new WispBackendError("invalid_request", "That path is not valid.");
  }
  if (value === "") {
    if (allowRoot) return [];
    throw new WispBackendError("invalid_request", "Choose files or folders inside the workspace.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.length > 255)) {
    throw new WispBackendError("invalid_request", "That path is not valid.");
  }
  return segments;
}

/**
 * The folder at `segments` under `root`, or null when it does not exist.
 * Every component must be a real folder: a symlink anywhere on the way is
 * refused, so the result is always inside the workspace.
 */
async function resolveFolder(root: string, segments: string[]): Promise<string | null> {
  let current = root;
  for (const segment of ["", ...segments]) {
    current = segment ? path.join(current, segment) : current;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WispBackendError("internal_error", "That folder could not be read.", true);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new WispBackendError("invalid_request", "That path is not a folder inside the workspace.");
    }
  }
  const real = await realpath(current).catch(() => null);
  const realRoot = await realpath(root).catch(() => null);
  if (!real || !realRoot || (real !== realRoot && !real.startsWith(realRoot + path.sep))) {
    throw new WispBackendError("invalid_request", "That path is not inside the workspace.");
  }
  return current;
}

/** The file or folder at `segments`, after checking its parents are real folders inside the workspace. */
async function resolveTarget(root: string, segments: string[]): Promise<string> {
  const parent = await resolveFolder(root, segments.slice(0, -1));
  if (parent === null) throw Object.assign(new Error("gone"), { code: "ENOENT" });
  const target = path.join(parent, segments[segments.length - 1]!);
  const info = await lstat(target);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new WispBackendError("invalid_request", "Only files and folders can be removed.");
  }
  return target;
}

async function readEntries(directory: string, parentSegments: string[]): Promise<StorageEntry[]> {
  let names;
  try {
    names = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new WispBackendError("internal_error", "That folder could not be read.", true);
  }
  return mapLimited(names, MEASURE_CONCURRENCY, (dirent) =>
    describeEntry(path.join(directory, dirent.name), [...parentSegments, dirent.name].join("/")),
  );
}

async function describeEntry(full: string, relative: string): Promise<StorageEntry> {
  const info = await lstat(full).catch(() => null);
  const type: StorageEntryType = !info
    ? "other"
    : info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "link"
          : "other";
  const base = { name: path.basename(full), path: relative, type, modifiedAt: info ? info.mtime.toISOString() : null };
  if (type === "directory") {
    const tree = await measureTree(full);
    return { ...base, size: tree.bytes, fileCount: tree.files, partial: tree.partial };
  }
  return { ...base, size: type === "file" ? info!.size : 0, fileCount: type === "file" ? 1 : 0, partial: !info };
}

async function inspectTargets(root: string, paths: ReadonlyArray<string>): Promise<StorageEntry[]> {
  if (!paths.length || paths.length > MAX_CLEANUP_PATHS) {
    throw new WispBackendError("invalid_request", "Choose which files or folders to remove.");
  }
  const parsed = [...new Set(paths)].map((value) => parseRelativePath(value, false));
  const keys = parsed.map((segments) => segments.join("/"));
  // A selected folder already covers what is inside it.
  const covered = new Set(keys.filter((key) => keys.some((other) => other !== key && isInside(key, other))));
  const items: StorageEntry[] = [];
  for (const segments of parsed.filter((segments) => !covered.has(segments.join("/")))) {
    let target: string;
    try {
      target = await resolveTarget(root, segments);
    } catch (error) {
      if (error instanceof WispBackendError) throw error;
      throw new WispBackendError("not_found", `${segments.join("/")} no longer exists.`);
    }
    const entry = await describeEntry(target, segments.join("/"));
    if (entry.partial) {
      throw new WispBackendError(
        "unavailable",
        `${entry.path} could not be fully read, so it cannot be removed safely.`,
      );
    }
    items.push(entry);
  }
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

function fingerprintOf(items: ReadonlyArray<StorageEntry>): string {
  const hash = createHash("sha256");
  for (const item of items)
    hash.update(JSON.stringify([item.path, item.type, item.size, item.fileCount, item.modifiedAt]));
  return hash.digest("hex");
}
