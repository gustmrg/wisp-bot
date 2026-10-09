import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  MAX_ATTACHMENTS_PER_REQUEST,
  WORKSPACE_INBOX_DIRECTORY,
  WORKSPACE_QUOTA_BYTES,
  formatBytes,
  type AttachWorkspaceFilesResult,
  type WorkspaceAttachment,
  type WorkspaceView,
} from "../shared/workspace.js";
import type { ImportSkillRequest, SkillView } from "../shared/skills.js";
import { WispBackendError } from "./backend-error.js";
import { parseSkillDocument, SkillStore } from "./skill-store.js";

/** Folder inside a Wisp's config directory that holds its skills. */
export const SKILLS_DIRECTORY = "skills";
const MAX_NAME_ATTEMPTS = 100;

/**
 * Total size of the regular files under a directory. Symlinks are neither
 * followed nor counted; a missing directory is empty.
 */
export async function measureDirectory(directory: string): Promise<number> {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        try {
          total += (await lstat(entryPath)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  return total;
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
  quotaBytes?: number;
  /** Held while files are written into a conversation's workspace; throws while it is being cleaned. */
  acquireWrite?: (conversationId: string) => () => void;
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
    const { workspaceDirectory } = this.options.resolveDirectories(conversationId);
    return { usedBytes: await measureDirectory(workspaceDirectory), quotaBytes: this.quotaBytes };
  }

  async openWorkspace(conversationId: string): Promise<void> {
    const { workspaceDirectory } = this.options.resolveDirectories(conversationId);
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
    const { workspaceDirectory } = this.options.resolveDirectories(conversationId);
    const selected = await this.options.selectFiles();
    if (!selected.length) return { files: [], workspace: await this.getView(conversationId) };
    const release = this.options.acquireWrite?.(conversationId);
    try {
      return await this.copyIntoInbox(conversationId, workspaceDirectory, selected);
    } finally {
      release?.();
    }
  }

  private async copyIntoInbox(
    conversationId: string,
    workspaceDirectory: string,
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
      this.quotaBytes,
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
    const { workspaceDirectory } = this.options.resolveDirectories(conversationId);
    const release = this.options.acquireWrite?.(conversationId);
    try {
      return await this.writeUpload(workspaceDirectory, file, content);
    } finally {
      release?.();
    }
  }

  private async writeUpload(
    workspaceDirectory: string,
    file: { name: string; size: number },
    content: AsyncIterable<Uint8Array>,
  ): Promise<WorkspaceAttachment> {
    await assertWorkspaceCapacity(workspaceDirectory, file.size, this.quotaBytes);
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
