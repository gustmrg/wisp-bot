import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readFile, readdir, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";

import {
  MAX_ATTACHMENTS_PER_REQUEST,
  WORKSPACE_INBOX_DIRECTORY,
  WORKSPACE_QUOTA_BYTES,
  WORKSPACE_QUOTA_PRESETS,
  formatBytes,
  type AttachWorkspaceFilesResult,
  type WorkspaceAttachment,
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

/**
 * Logical size and file count under a folder. Symlinks are neither followed
 * nor counted; a missing folder is empty, but unreadable ones mark the result
 * partial instead of reading as zero. `onFile` sees every file counted.
 */
export async function measureTree(directory: string, onFile?: (file: MeasuredFile) => void): Promise<TreeMeasurement> {
  const total: TreeMeasurement = { bytes: 0, files: 0, partial: false };
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
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        try {
          const info = await lstat(entryPath);
          total.bytes += info.size;
          total.files += 1;
          onFile?.({ path: entryPath, size: info.size, modifiedAt: info.mtime });
        } catch (error) {
          // A file removed during the scan is gone, not unreadable.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") total.partial = true;
        }
      }
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

/** Throws when adding `incomingBytes` would take the workspace past its quota. */
export async function assertWorkspaceCapacity(
  workspaceDirectory: string,
  incomingBytes: number,
  quotaBytes = WORKSPACE_QUOTA_BYTES,
): Promise<number> {
  const used = await measureDirectory(workspaceDirectory);
  if (used + incomingBytes > quotaBytes) {
    throw new WispBackendError(
      "invalid_request",
      `This Wisp's workspace is full (${formatBytes(used)} of ${formatBytes(quotaBytes)} used). Free some space before adding more files.`,
    );
  }
  return used;
}

/**
 * The size a Wisp's workspace was given, or `fallback` when it was never
 * resized. A setting that cannot be read throws rather than silently
 * shrinking the workspace back to the default.
 */
export async function readWorkspaceQuota(configDirectory: string, fallback = WORKSPACE_QUOTA_BYTES): Promise<number> {
  let contents: string;
  try {
    contents = await readFile(path.join(configDirectory, WORKSPACE_SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new WispBackendError("internal_error", "The workspace size could not be read.", true);
  }
  try {
    const { quotaBytes } = JSON.parse(contents) as { quotaBytes?: unknown };
    if (typeof quotaBytes === "number" && Number.isSafeInteger(quotaBytes) && quotaBytes > 0) return quotaBytes;
  } catch {
    // Falls through: a damaged file is reported like an unreadable one.
  }
  throw new WispBackendError("internal_error", "The workspace size could not be read.", true);
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

export interface WorkspaceServiceOptions {
  /** A Wisp's directories; throws for unknown conversations and circles. */
  resolveDirectories: (conversationId: string) => WorkspaceDirectories;
  /** Opens a local folder in the system file manager. */
  openPath: (directory: string) => Promise<void>;
  /** Asks the user to pick files; resolves with absolute paths, empty when dismissed. */
  selectFiles: () => Promise<ReadonlyArray<string>>;
  /** Any conversation's workspace folder, circles included; throws for unknown conversations. */
  resolveWorkspace?: (conversationId: string) => string;
  /** Size of a workspace whose Wisp was never resized. */
  quotaBytes?: number;
  /** Free space on the disk holding a folder; defaults to asking the operating system. */
  freeDiskBytes?: (directory: string) => Promise<number>;
  /** Held while files are written into a conversation's workspace; throws while it is being cleaned. */
  acquireWrite?: (conversationId: string) => () => void;
  /** Called after a workspace was given another size. */
  onQuotaChanged?: (conversationId: string) => void;
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

  constructor(options: WorkspaceServiceOptions) {
    this.options = options;
    this.quotaBytes = options.quotaBytes ?? WORKSPACE_QUOTA_BYTES;
  }

  async getView(conversationId: string): Promise<WorkspaceView> {
    const { workspaceDirectory, configDirectory } = this.options.resolveDirectories(conversationId);
    const [usedBytes, quotaBytes, freeBytes] = await Promise.all([
      measureDirectory(workspaceDirectory),
      this.quota(configDirectory),
      (this.options.freeDiskBytes ?? freeDiskBytes)(workspaceDirectory),
    ]);
    return { usedBytes, quotaBytes, maxQuotaBytes: largestQuota(usedBytes + freeBytes) };
  }

  /**
   * Gives a Wisp's workspace another size. Growing needs room on the disk;
   * shrinking below what the workspace holds deletes nothing and only stops
   * new files until enough is freed.
   */
  async setQuota(conversationId: string, quotaBytes: number): Promise<WorkspaceView> {
    if (!WORKSPACE_QUOTA_PRESETS.includes(quotaBytes)) {
      throw new WispBackendError("invalid_request", "Choose one of the offered workspace sizes.");
    }
    const { configDirectory } = this.options.resolveDirectories(conversationId);
    const view = await this.getView(conversationId);
    if (quotaBytes > view.quotaBytes && quotaBytes > view.maxQuotaBytes) {
      throw new WispBackendError(
        "invalid_request",
        `The disk does not have room for a ${formatBytes(quotaBytes)} workspace. Free some disk space or choose a smaller size.`,
      );
    }
    await writeFileAtomically(
      path.join(configDirectory, WORKSPACE_SETTINGS_FILE),
      `${JSON.stringify({ quotaBytes }, null, 2)}\n`,
    );
    this.options.onQuotaChanged?.(conversationId);
    return { ...view, quotaBytes };
  }

  private quota(configDirectory: string): Promise<number> {
    return readWorkspaceQuota(configDirectory, this.quotaBytes);
  }

  async openWorkspace(conversationId: string): Promise<void> {
    const workspaceDirectory =
      this.options.resolveWorkspace?.(conversationId) ??
      this.options.resolveDirectories(conversationId).workspaceDirectory;
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

  async attach(conversationId: string): Promise<AttachWorkspaceFilesResult> {
    const { workspaceDirectory, configDirectory } = this.options.resolveDirectories(conversationId);
    const selected = await this.options.selectFiles();
    if (!selected.length) return { files: [], workspace: await this.getView(conversationId) };
    const release = this.options.acquireWrite?.(conversationId);
    try {
      return await this.copyIntoInbox(conversationId, workspaceDirectory, await this.quota(configDirectory), selected);
    } finally {
      release?.();
    }
  }

  private async copyIntoInbox(
    conversationId: string,
    workspaceDirectory: string,
    quotaBytes: number,
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
    const { workspaceDirectory, configDirectory } = this.options.resolveDirectories(conversationId);
    const quotaBytes = await this.quota(configDirectory);
    const release = this.options.acquireWrite?.(conversationId);
    try {
      return await this.writeUpload(workspaceDirectory, quotaBytes, file, content);
    } finally {
      release?.();
    }
  }

  private async writeUpload(
    workspaceDirectory: string,
    quotaBytes: number,
    file: { name: string; size: number },
    content: AsyncIterable<Uint8Array>,
  ): Promise<WorkspaceAttachment> {
    await assertWorkspaceCapacity(workspaceDirectory, file.size, quotaBytes);
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
