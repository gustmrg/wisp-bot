import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILLS_PER_WISP,
  isValidSkillName,
  type SkillSummary,
  type SkillView,
} from "../../shared/skills.js";
import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";

const SKILL_FILE = "SKILL.md";
/** Frontmatter and instructions together; larger files are skipped rather than truncated. */
const MAX_SKILL_FILE_BYTES = 64 * 1024;

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

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
    if (!(await this.exists(skill.name)) && (await this.list()).length >= MAX_SKILLS_PER_WISP) {
      throw new WispBackendError(
        "invalid_request",
        `This Wisp already has ${MAX_SKILLS_PER_WISP} skills. Delete one before adding another.`,
      );
    }
    await writeFileAtomically(path.join(this.directory, skill.name, SKILL_FILE), formatSkillFile(skill));
    const saved = await this.load(skill.name);
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
  const draft = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (!isValidSkillName(draft.name)) {
    throw new WispBackendError(
      "invalid_request",
      "Skill names use lowercase letters, numbers, and single hyphens, up to 64 characters.",
    );
  }
  const description = typeof draft.description === "string" ? singleLine(draft.description) : "";
  if (!description || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new WispBackendError(
      "invalid_request",
      `A skill needs a description of at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
    );
  }
  const instructions = typeof draft.instructions === "string" ? draft.instructions.trim() : "";
  if (!instructions || instructions.length > MAX_SKILL_INSTRUCTIONS_LENGTH) {
    throw new WispBackendError(
      "invalid_request",
      `Skill instructions must be between 1 and ${MAX_SKILL_INSTRUCTIONS_LENGTH} characters.`,
    );
  }
  return { name: draft.name, description, instructions };
}

export function formatSkillFile(skill: SkillDraft): string {
  // JSON strings are valid YAML double-quoted scalars.
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}

/**
 * Reads the frontmatter fields Wisp uses (`description`) and the body. Accepts
 * plain or double-quoted single-line values; other YAML forms are ignored.
 */
export function parseSkillFile(contents: string): { description: string; instructions: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(contents.replace(/^﻿/, ""));
  if (!match) return null;
  let description = "";
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^description:\s*(.*)$/.exec(line);
    if (!field) continue;
    const raw = field[1]!.trim();
    if (raw.startsWith('"')) {
      try {
        const value: unknown = JSON.parse(raw);
        description = typeof value === "string" ? value : "";
      } catch {
        description = "";
      }
    } else {
      description = raw.replace(/^'(.*)'$/, "$1");
    }
  }
  return { description: singleLine(description), instructions: match[2]!.trim() };
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
