import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, readdir, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";

import ignore, { type Ignore } from "ignore";

import { rankFilePaths } from "../shared/file-mentions.js";
import {
  MAX_ATTACHMENTS_PER_REQUEST,
  WORKSPACE_DISK_RESERVE_BYTES,
  WORKSPACE_INBOX_DIRECTORY,
  WORKSPACE_QUOTA_BYTES,
  WORKSPACE_QUOTA_PRESETS,
  diskReserveMessage,
  formatBytes,
  unlimitedWorkspaceRoom,
  type AttachWorkspaceFilesResult,
  type SearchWorkspaceFilesRequest,
  type WorkspaceAttachment,
  type WorkspaceFileSearch,
  type WorkspaceView,
} from "../shared/workspace.js";
import type { ImportSkillRequest, SkillView } from "../shared/skills.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import { parseSkillDocument, SkillStore } from "./skill-store.js";

/** Folder inside a Wisp's config directory that holds its skills. */
export const SKILLS_DIRECTORY = "skills";
/** File inside a Wisp's config directory that holds its workspace size. */
export const WORKSPACE_SETTINGS_FILE = "workspace-settings.json";
const MAX_NAME_ATTEMPTS = 100;
/** Most files a workspace's file list holds, so even a huge checkout stays quick to search. */
export const MAX_LISTED_WORKSPACE_FILES = 50_000;
/** Folders never listed, ignored by Git or not: a repository's history and installed packages. */
const UNLISTED_DIRECTORIES = new Set([".git", "node_modules"]);
/** How long a workspace's file list is reused for searches. */
const FILE_LIST_LIFETIME_MS = 5_000;
/** Files measured at once in a folder. */
const MEASURE_BATCH_SIZE = 64;

export interface TreeMeasurement {
  bytes: number;
  files: number;
  /** Something under the folder could not be read, so the numbers are a lower bound. */
  partial: boolean;
}

/** A regular file met while measuring a folder. */
export interface MeasuredFile {
  /** Absolute path of the file. */
  path: string;
  size: number;
  modifiedAt: Date;
}

/** Ignore rules read in a folder, applying to the paths under it. */
interface IgnoreRules {
  /** The folder, relative to the workspace root; empty for the root. */
  folder: string;
  rules: Ignore;
}

/**
 * Paths of the files in a workspace, relative to its root with forward
 * slashes, folder by folder from the root so the shallowest come first.
 * What Git ignores is left out: each folder's `.gitignore` and a
 * repository's `.git/info/exclude` apply below them, deeper rules winning,
 * as in a workspace holding cloned repositories. Symlinks are not followed,
 * `.git` and `node_modules` are always left out, and the list stops at
 * `MAX_LISTED_WORKSPACE_FILES`.
 */
export async function listWorkspaceFiles(workspaceDirectory: string): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const pending: Array<{ folder: string; inherited: ReadonlyArray<IgnoreRules> }> = [{ folder: "", inherited: [] }];
  for (let index = 0; index < pending.length && files.length < MAX_LISTED_WORKSPACE_FILES; index += 1) {
    const { folder, inherited } = pending[index]!;
    const directory = path.join(workspaceDirectory, folder);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // A folder that went away or cannot be read has nothing to offer.
      continue;
    }
    const scopes = [...inherited];
    const ruleFiles = [".gitignore", ...(entries.some((entry) => entry.name === ".git") ? [".git/info/exclude"] : [])];
    for (const ruleFile of ruleFiles) {
      const text = await readFile(path.join(directory, ruleFile), "utf8").catch(() => null);
      if (text) scopes.push({ folder, rules: ignore().add(text) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      if (isDirectory ? UNLISTED_DIRECTORIES.has(entry.name) : !entry.isFile()) continue;
      if (isIgnored(relative, isDirectory, scopes)) continue;
      if (isDirectory) pending.push({ folder: relative, inherited: scopes });
      else if (files.length < MAX_LISTED_WORKSPACE_FILES) files.push(relative);
    }
  }
  return files;
}

function isIgnored(relative: string, isDirectory: boolean, scopes: ReadonlyArray<IgnoreRules>): boolean {
  let ignored = false;
  for (const { folder, rules } of scopes) {
    const inFolder = folder ? relative.slice(folder.length + 1) : relative;
    const result = rules.test(isDirectory ? `${inFolder}/` : inFolder);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Logical size and file count under a folder. Symlinks are neither followed
 * nor counted, and a file hard-linked in several places (as pnpm links its
 * store into node_modules) counts once, where it is first met. A missing
 * folder is empty, but unreadable ones mark the result partial instead of
 * reading as zero. `onFile` sees every file counted.
 */
export async function measureTree(directory: string, onFile?: (file: MeasuredFile) => void): Promise<TreeMeasurement> {
  const total: TreeMeasurement = { bytes: 0, files: 0, partial: false };
  const linked = new Set<string>();
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") total.partial = true;
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
    // Files are read a batch at a time, which matters on slow disks, and counted in order, so the
    // place a hard-linked file is counted stays the same as reading them one by one.
    for (let start = 0; start < files.length; start += MEASURE_BATCH_SIZE) {
      const batch = files.slice(start, start + MEASURE_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map((file) => lstat(file, { bigint: true })));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          // A file removed during the scan is gone, not unreadable.
          if ((result.reason as NodeJS.ErrnoException).code !== "ENOENT") total.partial = true;
          return;
        }
        const info = result.value;
        if (info.nlink > 1n) {
          const identity = `${info.dev}:${info.ino}`;
          if (linked.has(identity)) return;
          linked.add(identity);
        }
        const size = Number(info.size);
        total.bytes += size;
        total.files += 1;
        onFile?.({ path: batch[index]!, size, modifiedAt: info.mtime });
      });
    }
  }
  return total;
}

/**
 * Total size of the regular files under a directory, measured like Storage
 * does. Throws when part of it cannot be read, so a quota is never checked
 * against a lower bound.
 */
export async function measureDirectory(directory: string): Promise<number> {
  const { bytes, partial } = await measureTree(directory);
  if (partial) throw new WispBackendError("internal_error", "The workspace could not be fully read.", true);
  return bytes;
}

/**
 * Throws when adding `incomingBytes` would take the workspace past its quota,
 * or, for a workspace without one (`null`), its disk below the reserve.
 */
export async function assertWorkspaceCapacity(
  workspaceDirectory: string,
  incomingBytes: number,
  quotaBytes: number | null = WORKSPACE_QUOTA_BYTES,
  measureFreeDisk: (directory: string) => Promise<number> = freeDiskBytes,
): Promise<void> {
  if (quotaBytes === null) {
    await assertDiskReserve(workspaceDirectory, incomingBytes, "before adding more files", measureFreeDisk);
    return;
  }
  const used = await measureDirectory(workspaceDirectory);
  if (used + incomingBytes > quotaBytes) {
    throw new WispBackendError(
      "invalid_request",
      `This workspace is full (${formatBytes(used)} of ${formatBytes(quotaBytes)} used). Free some space before adding more files.`,
    );
  }
}

/**
 * Throws when writing `incomingBytes` into a workspace without a size would
 * leave less than the reserve free on its disk. It asks the operating system
 * once and reads no files, so it costs far less than measuring the workspace.
 */
export async function assertDiskReserve(
  workspaceDirectory: string,
  incomingBytes: number,
  /** How the message ends: what to free space before. */
  before: string,
  measureFreeDisk: (directory: string) => Promise<number> = freeDiskBytes,
): Promise<void> {
  const free = await measureFreeDisk(workspaceDirectory);
  if (free - incomingBytes < WORKSPACE_DISK_RESERVE_BYTES) {
    throw new WispBackendError("invalid_request", diskReserveMessage(free, before));
  }
}

/** The size a workspace was given, as saved beside its settings. */
export interface WorkspaceSizeSetting {
  /** The size in bytes. With `unlimited`, the last size it had, which builds older than that flag still apply. */
  quotaBytes: number;
  unlimited: boolean;
}

/**
 * The size a workspace was given, read from the folder keeping its settings
 * (a Wisp's or a circle's), or `fallback` when it was never resized. A setting that cannot be read throws rather than silently
 * shrinking the workspace back to the default.
 */
export async function readWorkspaceSizeSetting(
  configDirectory: string,
  fallback = WORKSPACE_QUOTA_BYTES,
): Promise<WorkspaceSizeSetting> {
  let contents: string;
  try {
    contents = await readFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { quotaBytes: fallback, unlimited: false };
    throw new WispBackendError("internal_error", "The workspace size could not be read.", true);
  }
  try {
    const { quotaBytes, unlimited } = JSON.parse(contents) as { quotaBytes?: unknown; unlimited?: unknown };
    if (
      typeof quotaBytes === "number" &&
      Number.isSafeInteger(quotaBytes) &&
      quotaBytes > 0 &&
      (unlimited === undefined || typeof unlimited === "boolean")
    ) {
      return { quotaBytes, unlimited: unlimited === true };
    }
  } catch {
    // Falls through: a damaged file is reported like an unreadable one.
  }
  throw new WispBackendError("internal_error", "The workspace size could not be read.", true);
}

/** The size a workspace was given, or `null` when it has none; see `readWorkspaceSizeSetting`. */
export async function readWorkspaceQuota(
  configDirectory: string,
  fallback = WORKSPACE_QUOTA_BYTES,
): Promise<number | null> {
  const setting = await readWorkspaceSizeSetting(configDirectory, fallback);
  return setting.unlimited ? null : setting.quotaBytes;
}

/**
 * Free space on the disk that holds `directory`, measured at its nearest
 * existing ancestor so a workspace that was never written to still has an answer.
 */
export async function freeDiskBytes(directory: string): Promise<number> {
  let current = directory;
  for (;;) {
    try {
      const { bavail, bsize } = await statfs(current);
      return Number(bavail) * Number(bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) {
        throw new WispBackendError("internal_error", "The free disk space could not be measured.", true);
      }
      current = parent;
    }
  }
}

export interface WorkspaceDirectories {
  workspaceDirectory: string;
  configDirectory: string;
}

/** A conversation's workspace and the folder keeping its size: the Wisp's settings, or the circle's. */
export interface ConversationWorkspaceDirectories {
  workspaceDirectory: string;
  settingsDirectory: string;
}

export interface WorkspaceServiceOptions {
  /** A Wisp's directories; throws for unknown conversations and circles. */
  resolveDirectories: (conversationId: string) => WorkspaceDirectories;
  /** Opens a local folder in the system file manager. */
  openPath: (directory: string) => Promise<void>;
  /** Asks the user to pick files; resolves with absolute paths, empty when dismissed. */
  selectFiles: () => Promise<ReadonlyArray<string>>;
  /** Any conversation's workspace folders, circles included; throws for unknown conversations. Unset, only Wisps'. */
  resolveWorkspace?: (conversationId: string) => ConversationWorkspaceDirectories;
  /** Size of a workspace whose Wisp was never resized. */
  quotaBytes?: number;
  /** Free space on the disk holding a folder; defaults to asking the operating system. */
  freeDiskBytes?: (directory: string) => Promise<number>;
  /** Held while files are written into a conversation's workspace; throws while it is being cleaned. */
  acquireWrite?: (conversationId: string) => () => void;
  /** Called after a workspace was given another size. */
  onQuotaChanged?: (conversationId: string) => void;
  /** Folder that holds every Wisp's workspace, where a new Wisp's workspace is created. */
  workspaceRoot?: string;
}

/**
 * Owns the user-facing side of each Wisp's private folders: opening them,
 * reporting workspace usage, and copying user-picked files into the
 * workspace inbox. Paths come only from the backend and the native picker,
 * never from the renderer.
 */
export class WorkspaceService {
  private readonly options: WorkspaceServiceOptions;
  private readonly quotaBytes: number;
  private readonly fileLists = new Map<string, { at: number; files: Promise<ReadonlyArray<string>> }>();

  constructor(options: WorkspaceServiceOptions) {
    this.options = options;
    this.quotaBytes = options.quotaBytes ?? WORKSPACE_QUOTA_BYTES;
  }

  async getView(conversationId: string): Promise<WorkspaceView> {
    return (await this.measure(conversationId)).view;
  }

  private async measure(conversationId: string): Promise<{ view: WorkspaceView; setting: WorkspaceSizeSetting }> {
    const { workspaceDirectory, settingsDirectory } = this.workspace(conversationId);
    const [usedBytes, setting, freeBytes] = await Promise.all([
      measureDirectory(workspaceDirectory),
      readWorkspaceSizeSetting(settingsDirectory, this.quotaBytes),
      this.freeDiskBytes(workspaceDirectory),
    ]);
    return {
      view: {
        usedBytes,
        quotaBytes: setting.unlimited ? unlimitedWorkspaceRoom(usedBytes, freeBytes) : setting.quotaBytes,
        maxQuotaBytes: largestQuota(usedBytes + freeBytes),
        unlimited: setting.unlimited,
        freeDiskBytes: freeBytes,
      },
      setting,
    };
  }

  private freeDiskBytes(directory: string): Promise<number> {
    return (this.options.freeDiskBytes ?? freeDiskBytes)(directory);
  }

  /** The largest size a Wisp created now could be given. */
  async newWorkspaceRoom(): Promise<number> {
    const { workspaceRoot } = this.options;
    if (!workspaceRoot)
      throw new WispBackendError("internal_error", "The free disk space could not be measured.", true);
    return largestQuota(await this.freeDiskBytes(workspaceRoot));
  }

  /**
   * Gives a Wisp's or a circle's workspace another size, or none (`null`).
   * Growing needs room on the disk; shrinking below what the workspace holds
   * deletes nothing and only stops new files until enough is freed. Without a
   * size, new files stop when the disk is down to the reserve.
   */
  async setQuota(conversationId: string, quotaBytes: number | null): Promise<WorkspaceView> {
    if (quotaBytes !== null && !WORKSPACE_QUOTA_PRESETS.includes(quotaBytes)) {
      throw new WispBackendError("invalid_request", "Choose one of the offered workspace sizes.");
    }
    const { settingsDirectory } = this.workspace(conversationId);
    const { view, setting } = await this.measure(conversationId);
    const growing = quotaBytes !== null && (setting.unlimited || quotaBytes > setting.quotaBytes);
    if (growing && quotaBytes > view.maxQuotaBytes) {
      throw new WispBackendError(
        "invalid_request",
        `The disk does not have room for a ${formatBytes(quotaBytes)} workspace. Free some disk space or choose a smaller size.`,
      );
    }
    // Without a size, the last one stays saved: builds older than `unlimited` apply it instead.
    const saved = quotaBytes === null ? { quotaBytes: setting.quotaBytes, unlimited: true } : { quotaBytes };
    // A circle's settings folder exists only once it is first resized.
    await mkdir(settingsDirectory, { recursive: true });
    await writeFileAtomically(
      path.join(settingsDirectory, WORKSPACE_SETTINGS_FILE),
      `${JSON.stringify(saved, null, 2)}\n`,
    );
    this.options.onQuotaChanged?.(conversationId);
    return {
      ...view,
      quotaBytes: quotaBytes ?? unlimitedWorkspaceRoom(view.usedBytes, view.freeDiskBytes ?? 0),
      unlimited: quotaBytes === null,
    };
  }

  private quota(settingsDirectory: string): Promise<number | null> {
    return readWorkspaceQuota(settingsDirectory, this.quotaBytes);
  }

  private workspace(conversationId: string): ConversationWorkspaceDirectories {
    if (this.options.resolveWorkspace) return this.options.resolveWorkspace(conversationId);
    const { workspaceDirectory, configDirectory } = this.options.resolveDirectories(conversationId);
    return { workspaceDirectory, settingsDirectory: configDirectory };
  }

  async openWorkspace(conversationId: string): Promise<void> {
    const { workspaceDirectory } = this.workspace(conversationId);
    await mkdir(workspaceDirectory, { recursive: true });
    await this.options.openPath(workspaceDirectory);
  }

  async openSkills(conversationId: string): Promise<void> {
    const { configDirectory } = this.options.resolveDirectories(conversationId);
    const skillsDirectory = path.join(configDirectory, SKILLS_DIRECTORY);
    await mkdir(skillsDirectory, { recursive: true });
    await this.options.openPath(skillsDirectory);
  }

  listSkills(conversationId: string): Promise<ReadonlyArray<SkillView>> {
    return this.skills(conversationId).list();
  }

  async deleteSkill(conversationId: string, name: string): Promise<ReadonlyArray<SkillView>> {
    const skills = this.skills(conversationId);
    await skills.delete(name);
    return skills.list();
  }

  /**
   * Saves a SKILL.md the user picked in settings. The user chose this file
   * themselves, so no approval card is shown, but replacing an existing skill
   * needs an explicit `replace`.
   */
  async importSkill(request: ImportSkillRequest): Promise<ReadonlyArray<SkillView>> {
    const skills = this.skills(request.conversationId);
    const { draft, contents } = parseSkillDocument(request.contents);
    if (!request.replace && (await skills.exists(draft.name))) {
      throw new WispBackendError("already_exists", `A skill named ${draft.name} already exists.`);
    }
    await skills.import(contents);
    return skills.list();
  }

  private skills(conversationId: string): SkillStore {
    const { configDirectory } = this.options.resolveDirectories(conversationId);
    return new SkillStore(path.join(configDirectory, SKILLS_DIRECTORY));
  }

  /**
   * The files in a conversation's workspace best matching what follows an `@` (see
   * `rankFilePaths`). The workspace's file list is kept for a few seconds, so
   * typing a query reads the disk once rather than at every key.
   */
  async searchFiles({ conversationId, query }: SearchWorkspaceFilesRequest): Promise<WorkspaceFileSearch> {
    const now = Date.now();
    let cached = this.fileLists.get(conversationId);
    if (!cached || now - cached.at > FILE_LIST_LIFETIME_MS) {
      const { workspaceDirectory } = this.workspace(conversationId);
      cached = { at: now, files: listWorkspaceFiles(workspaceDirectory) };
      this.fileLists.set(conversationId, cached);
      // A failed listing is not kept, so the next search tries again.
      cached.files.catch(() => this.fileLists.delete(conversationId));
    }
    const files = await cached.files;
    return { paths: rankFilePaths(files, query), empty: !files.length };
  }

  async attach(conversationId: string): Promise<AttachWorkspaceFilesResult> {
    const { workspaceDirectory, settingsDirectory } = this.workspace(conversationId);
    const selected = await this.options.selectFiles();
    if (!selected.length) return { files: [], workspace: await this.getView(conversationId) };
    const release = this.options.acquireWrite?.(conversationId);
    try {
      return await this.copyIntoInbox(
        conversationId,
        workspaceDirectory,
        await this.quota(settingsDirectory),
        selected,
      );
    } finally {
      release?.();
    }
  }

  private async copyIntoInbox(
    conversationId: string,
    workspaceDirectory: string,
    quotaBytes: number | null,
    selected: ReadonlyArray<string>,
  ): Promise<AttachWorkspaceFilesResult> {
    if (selected.length > MAX_ATTACHMENTS_PER_REQUEST) {
      throw new WispBackendError("invalid_request", `Attach at most ${MAX_ATTACHMENTS_PER_REQUEST} files at a time.`);
    }
    const sources: Array<{ source: string; size: number }> = [];
    for (const source of selected) {
      const info = await stat(source).catch(() => null);
      if (!info?.isFile()) {
        throw new WispBackendError("invalid_request", `${path.basename(source)} is not a readable file.`);
      }
      sources.push({ source, size: info.size });
    }
    await assertWorkspaceCapacity(
      workspaceDirectory,
      sources.reduce((sum, { size }) => sum + size, 0),
      quotaBytes,
      (directory) => this.freeDiskBytes(directory),
    );

    const inbox = await prepareInbox(workspaceDirectory);
    const files: WorkspaceAttachment[] = [];
    for (const { source, size } of sources) {
      const name = await copyWithUniqueName(source, inbox, safeFileName(path.basename(source)));
      files.push({ name, path: `${WORKSPACE_INBOX_DIRECTORY}/${name}`, size });
    }
    return { files, workspace: await this.getView(conversationId) };
  }

  /**
   * Writes a file sent by a device on another computer into the workspace
   * inbox. The bytes land in a hidden partial file and take their name only
   * once exactly `size` bytes arrived, so a Wisp never reads half a file.
   */
  async receive(
    conversationId: string,
    file: { name: string; size: number },
    content: AsyncIterable<Uint8Array>,
  ): Promise<WorkspaceAttachment> {
    const { workspaceDirectory, settingsDirectory } = this.workspace(conversationId);
    const quotaBytes = await this.quota(settingsDirectory);
    const release = this.options.acquireWrite?.(conversationId);
    try {
      return await this.writeUpload(workspaceDirectory, quotaBytes, file, content);
    } finally {
      release?.();
    }
  }

  private async writeUpload(
    workspaceDirectory: string,
    quotaBytes: number | null,
    file: { name: string; size: number },
    content: AsyncIterable<Uint8Array>,
  ): Promise<WorkspaceAttachment> {
    await assertWorkspaceCapacity(workspaceDirectory, file.size, quotaBytes, (directory) =>
      this.freeDiskBytes(directory),
    );
    const inbox = await prepareInbox(workspaceDirectory);
    const partial = path.join(inbox, `.upload-${randomUUID()}.partial`);
    const handle = await open(partial, "wx", 0o600);
    try {
      let received = 0;
      try {
        for await (const chunk of content) {
          received += chunk.byteLength;
          if (received > file.size) break;
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      if (received !== file.size) {
        throw new WispBackendError("invalid_request", `${file.name} did not arrive complete. Try attaching it again.`);
      }
      const name = await linkWithUniqueName(partial, inbox, safeFileName(file.name));
      return { name, path: `${WORKSPACE_INBOX_DIRECTORY}/${name}`, size: file.size };
    } finally {
      await unlink(partial).catch(() => undefined);
    }
  }
}

/** The largest offered size a workspace can grow into with `roomBytes` of disk, never below the smallest. */
export function largestQuota(roomBytes: number): number {
  return WORKSPACE_QUOTA_PRESETS.filter((preset) => preset <= roomBytes).at(-1) ?? WORKSPACE_QUOTA_PRESETS[0]!;
}

/** The workspace folder that receives attachments, created on first use. */
async function prepareInbox(workspaceDirectory: string): Promise<string> {
  const inbox = path.join(workspaceDirectory, WORKSPACE_INBOX_DIRECTORY);
  await mkdir(inbox, { recursive: true });
  if (!(await lstat(inbox)).isDirectory()) {
    throw new WispBackendError("invalid_request", "The workspace inbox is not a folder.");
  }
  return inbox;
}

/** A single path segment safe on every platform, keeping the original name where possible. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 180);
  return cleaned || "attachment";
}

function copyWithUniqueName(source: string, directory: string, name: string): Promise<string> {
  // COPYFILE_EXCL never replaces an existing file, so concurrent copies cannot clobber each other.
  return placeWithUniqueName(
    directory,
    name,
    (target) => copyFile(source, target, constants.COPYFILE_EXCL),
    `Could not copy ${path.basename(source)} into the workspace.`,
  );
}

function linkWithUniqueName(partial: string, directory: string, name: string): Promise<string> {
  // Unlike a rename, a hard link never replaces an existing file.
  return placeWithUniqueName(
    directory,
    name,
    (target) => link(partial, target),
    `Could not save ${name} in the workspace.`,
  );
}

async function placeWithUniqueName(
  directory: string,
  name: string,
  place: (target: string) => Promise<void>,
  failure: string,
): Promise<string> {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length) || name;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem} (${attempt})${extension}`;
    try {
      await place(path.join(directory, candidate));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new WispBackendError("invalid_request", failure);
    }
  }
  throw new WispBackendError("invalid_request", `Could not find a free name for ${name} in the workspace.`);
}
