/** Agent Skills naming: lowercase letters, numbers, and single hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 16_000;
export const MAX_SKILLS_PER_WISP = 50;
/** Frontmatter and instructions together; larger files are skipped rather than truncated. */
export const MAX_SKILL_FILE_BYTES = 64 * 1024;

export interface SkillSummary {
  name: string;
  description: string;
  updatedAt: string;
}

export interface SkillView extends SkillSummary {
  instructions: string;
}

export interface SkillRequest {
  conversationId: string;
  name: string;
}

/** A complete SKILL.md the user picked, saved as written. */
export interface ImportSkillRequest {
  conversationId: string;
  contents: string;
  /** Replaces a skill with the same name; without it, an existing name fails with `already_exists`. */
  replace?: boolean;
}

export function isValidSkillName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(value);
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export function formatSkillFile(skill: SkillDraft): string {
  // JSON strings are valid YAML double-quoted scalars.
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}

/** A skill checked against the limits a Wisp's skills follow, or why it does not meet them. */
export type SkillCheck = { ok: true; draft: SkillDraft } | { ok: false; error: string };

export function checkSkillDraft(value: unknown): SkillCheck {
  const draft = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (!isValidSkillName(draft.name)) {
    return { ok: false, error: "Skill names use lowercase letters, numbers, and single hyphens, up to 64 characters." };
  }
  const description = typeof draft.description === "string" ? singleLine(draft.description) : "";
  if (!description || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return { ok: false, error: `A skill needs a description of at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.` };
  }
  const instructions = typeof draft.instructions === "string" ? draft.instructions.trim() : "";
  if (!instructions || instructions.length > MAX_SKILL_INSTRUCTIONS_LENGTH) {
    return {
      ok: false,
      error: `Skill instructions must be between 1 and ${MAX_SKILL_INSTRUCTIONS_LENGTH} characters.`,
    };
  }
  return { ok: true, draft: { name: draft.name, description, instructions } };
}

/**
 * Checks a complete SKILL.md, from a picked file, the Wisp's workspace or a
 * template, and returns it ready to store as is.
 */
export function checkSkillDocument(
  value: unknown,
): { ok: true; draft: SkillDraft; contents: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "The skill file is empty." };
  if (new TextEncoder().encode(value).length > MAX_SKILL_FILE_BYTES) {
    return { ok: false, error: `A skill file can be at most ${MAX_SKILL_FILE_BYTES / 1024} KiB.` };
  }
  const parsed = parseSkillFile(value);
  if (!parsed) {
    return {
      ok: false,
      error: "A skill file starts with frontmatter between --- lines holding its name and description.",
    };
  }
  if (!parsed.name) return { ok: false, error: "The skill file needs a name field in its frontmatter." };
  const checked = checkSkillDraft(parsed);
  if (!checked.ok) return checked;
  const contents = value.replace(/^\uFEFF/, "");
  return { ok: true, draft: checked.draft, contents: contents.endsWith("\n") ? contents : `${contents}\n` };
}

/**
 * Reads the frontmatter fields Wisp uses (`name`, `description`) and the body.
 * Accepts plain or double-quoted single-line values; other YAML forms are ignored.
 */
export function parseSkillFile(contents: string): { name: string; description: string; instructions: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(contents.replace(/^\uFEFF/, ""));
  if (!match) return null;
  const fields: Record<string, string> = { name: "", description: "" };
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = scalarValue(field[2]!.trim());
  }
  return { name: fields.name!.trim(), description: singleLine(fields.description!), instructions: match[2]!.trim() };
}

function scalarValue(raw: string): string {
  // Multi-line YAML values (`>` or `|` blocks) are not read.
  if (/^[|>][-+0-9]*$/.test(raw)) return "";
  if (!raw.startsWith('"')) return raw.replace(/^'(.*)'$/, "$1");
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
