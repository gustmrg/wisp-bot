/** Agent Skills naming: lowercase letters, numbers, and single hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 16_000;
export const MAX_SKILLS_PER_WISP = 50;

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
