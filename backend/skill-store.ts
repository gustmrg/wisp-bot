import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILLS_PER_WISP,
  checkSkillDocument,
  checkSkillDraft,
  formatSkillFile,
  isValidSkillName,
  parseSkillFile,
  type SkillDraft,
  type SkillSummary,
  type SkillView,
} from "../shared/skills.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";

export { MAX_SKILL_FILE_BYTES, formatSkillFile, parseSkillFile, type SkillDraft };

const SKILL_FILE = "SKILL.md";

/**
 * One Wisp's skills, stored as Agent Skills folders (`<name>/SKILL.md`) in the
 * Wisp's config directory. Files the user edits by hand are re-read on every
 * call; anything malformed, oversized, or reached through a symlink is skipped.
 */
export class SkillStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async list(): Promise<ReadonlyArray<SkillView>> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && isValidSkillName(entry.name))
      .map(({ name }) => name)
      .sort();
    const skills: SkillView[] = [];
    for (const name of names) {
      const skill = await this.load(name);
      if (skill) skills.push(skill);
      if (skills.length >= MAX_SKILLS_PER_WISP) break;
    }
    return skills;
  }

  async summaries(): Promise<ReadonlyArray<SkillSummary>> {
    return (await this.list()).map(({ name, description, updatedAt }) => ({ name, description, updatedAt }));
  }

  async get(name: string): Promise<SkillView | null> {
    return isValidSkillName(name) ? this.load(name) : null;
  }

  async exists(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  async save(draft: SkillDraft): Promise<SkillView> {
    const skill = validateSkillDraft(draft);
    return this.write(skill.name, formatSkillFile(skill));
  }

  /**
   * Saves a complete SKILL.md exactly as written, keeping frontmatter fields
   * Wisp does not use. The file must pass `parseSkillDocument`.
   */
  async import(contents: string): Promise<SkillView> {
    const document = parseSkillDocument(contents);
    return this.write(document.draft.name, document.contents);
  }

  private async write(name: string, contents: string): Promise<SkillView> {
    if (!(await this.exists(name)) && (await this.list()).length >= MAX_SKILLS_PER_WISP) {
      throw new WispBackendError(
        "invalid_request",
        `This Wisp already has ${MAX_SKILLS_PER_WISP} skills. Delete one before adding another.`,
      );
    }
    await writeFileAtomically(path.join(this.directory, name, SKILL_FILE), contents);
    const saved = await this.load(name);
    if (!saved) throw new WispBackendError("internal_error", "The skill could not be saved.");
    return saved;
  }

  async delete(name: string): Promise<void> {
    if (!isValidSkillName(name)) throw new WispBackendError("invalid_request", "The skill name is invalid.");
    const folder = path.join(this.directory, name);
    const info = await lstat(folder).catch(() => null);
    if (!info) throw new WispBackendError("not_found", "This skill no longer exists.");
    if (!info.isDirectory()) throw new WispBackendError("invalid_request", "The skill folder is invalid.");
    await rm(folder, { recursive: true, force: true });
  }

  private async load(name: string): Promise<SkillView | null> {
    const filePath = path.join(this.directory, name, SKILL_FILE);
    try {
      const [folder, file] = await Promise.all([lstat(path.dirname(filePath)), lstat(filePath)]);
      if (!folder.isDirectory() || !file.isFile() || file.size > MAX_SKILL_FILE_BYTES) return null;
      const parsed = parseSkillFile(await readFile(filePath, "utf8"));
      if (!parsed?.description || parsed.description.length > MAX_SKILL_DESCRIPTION_LENGTH) return null;
      return {
        name,
        description: parsed.description,
        instructions: parsed.instructions.slice(0, MAX_SKILL_INSTRUCTIONS_LENGTH),
        updatedAt: file.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }
}

export function validateSkillDraft(value: unknown): SkillDraft {
  const checked = checkSkillDraft(value);
  if (!checked.ok) throw new WispBackendError("invalid_request", checked.error);
  return checked.draft;
}

/**
 * Checks a complete SKILL.md sent by the user, from a picked file or the
 * Wisp's workspace, and returns it ready to store as is.
 */
export function parseSkillDocument(value: unknown): { draft: SkillDraft; contents: string } {
  const checked = checkSkillDocument(value);
  if (!checked.ok) throw new WispBackendError("invalid_request", checked.error);
  return { draft: checked.draft, contents: checked.contents };
}
