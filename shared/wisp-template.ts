import { isThinkingLevel, type ModelSelection } from "./contracts.js";
import { WISP_NAME_MAX_LENGTH, WISP_ROLE_MAX_LENGTH, WISP_SOUL_MAX_LENGTH } from "./conversations.js";
import { EXECUTION_MODES, type ExecutionMode } from "./execution.js";
import { PLUGIN_IDS, type PluginId } from "./plugins.js";
import { MAX_SKILLS_PER_WISP, checkSkillDocument } from "./skills.js";
import type { ToolPolicyBehavior, WorkspaceFileCategory } from "./tool-policy.js";
import {
  DEFAULT_WISP_APPEARANCE,
  WISP_APPEARANCE_AXES,
  isWispAppearanceValue,
  wispPaletteColor,
  type WispAppearance,
} from "./wisp-appearance.js";
import { WORKSPACE_QUOTA_PRESETS } from "./workspace.js";

export const WISP_TEMPLATE_FORMAT = "wisp-template";
/**
 * Version 1 carried the name, role, soul and model. Version 2 adds the rest of
 * a Wisp's setup; a template that uses none of it is still written as version
 * 1, so older apps keep reading what this one shares.
 */
export const WISP_TEMPLATE_VERSION = 2;
/** One line on what a Wisp made from the template does, for the template's card. */
export const WISP_TEMPLATE_DESCRIPTION_MAX_LENGTH = 200;
/** Far above the largest valid template, skills included; longer text is rejected before parsing. */
export const MAX_WISP_TEMPLATE_TEXT_LENGTH = 4 * 1024 * 1024;

/** A skill the Wisp starts with: a complete SKILL.md, saved as written. */
export interface WispTemplateSkill {
  contents: string;
}

/**
 * Access a template asks for. None of it is granted by the template: the
 * person confirms each part when creating the Wisp, and the backend checks it
 * as it would a change made by hand. It never carries credentials, and plugins
 * and MCP servers are named by ID, so only ones set up here can be granted.
 */
export interface WispTemplateAccess {
  /** File changes in the Wisp's workspace; a category left out follows the app-wide setting. */
  files?: Partial<Record<WorkspaceFileCategory, ToolPolicyBehavior>>;
  /** Risk mode, as in `WispToolPolicy.allowEverything`. */
  allowEverything?: boolean;
  plugins?: ReadonlyArray<{ pluginId: PluginId; access: "read" | "write" }>;
  /** `name` is shown when no server with that ID is set up here. */
  mcpServers?: ReadonlyArray<{ serverId: string; name: string; access: "use_with_approval" | "allow_all" }>;
}

/** Where a Wisp made from the template works. */
export interface WispTemplateSetup {
  /** One of `WORKSPACE_QUOTA_PRESETS`, or `null` for no size. */
  quotaBytes?: number | null;
  executionMode?: ExecutionMode;
}

/** A complete starting point for a Wisp: its identity, soul, skills, model and setup. */
export interface WispTemplate {
  name: string;
  role: string;
  soul: string;
  description?: string;
  appearance?: WispAppearance;
  /** One of `WISP_COLORS`. */
  color?: string;
  model?: ModelSelection;
  skills?: ReadonlyArray<WispTemplateSkill>;
  setup?: WispTemplateSetup;
  access?: WispTemplateAccess;
}

/** A template as the Templates section lists it. */
export interface WispTemplateEntry {
  /** `builtin-…` for the templates that ship with the app. */
  id: string;
  builtIn: boolean;
  template: WispTemplate;
  /** When a saved template last changed, as ISO 8601; null for built-ins. */
  updatedAt: string | null;
}

/**
 * Saves a template on the server: a new one without `id`, or replaces a saved
 * one. `contents` is the template as `serializeWispTemplate` writes it, so an
 * imported file and an edit are checked the same way.
 */
export interface SaveWispTemplateRequest {
  id?: string;
  contents: string;
}

export interface DeleteWispTemplateRequest {
  id: string;
}

/** Most templates the person can save in one environment. */
export const MAX_SAVED_WISP_TEMPLATES = 200;

export type WispTemplateParseResult = { ok: true; template: WispTemplate } | { ok: false; error: string };

const INVALID_TEMPLATE = "This is not a valid Wisp template. Export or copy it again from Wisp Bot.";

/** The fields only version 2 knows; a template with none of them is written as version 1. */
const VERSION_2_FIELDS = ["description", "appearance", "color", "skills", "setup", "access"] as const;

/** What Share as template copies from a Wisp: how it behaves and the model it was made with, never how it looks. */
export function wispTemplateFrom(
  wisp: { name: string; role: string; soul: string },
  model: ModelSelection | null,
): WispTemplate {
  return { name: wisp.name, role: wisp.role, soul: wisp.soul, ...(model ? { model } : {}) };
}

export function serializeWispTemplate(template: WispTemplate): string {
  const version = VERSION_2_FIELDS.some((field) => template[field] !== undefined) ? WISP_TEMPLATE_VERSION : 1;
  return JSON.stringify({ format: WISP_TEMPLATE_FORMAT, version, ...template }, null, 2);
}

export function parseWispTemplate(text: string): WispTemplateParseResult {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_WISP_TEMPLATE_TEXT_LENGTH) return invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return invalid();
  }
  if (!isRecord(raw) || raw.format !== WISP_TEMPLATE_FORMAT || !Number.isSafeInteger(raw.version)) return invalid();
  const version = raw.version as number;
  if (version > WISP_TEMPLATE_VERSION)
    return invalid("This template was made by a newer version of Wisp Bot. Update the app to import it.");
  if (version < 1) return invalid();

  const name = limitedString(raw.name, WISP_NAME_MAX_LENGTH);
  const role = limitedString(raw.role, WISP_ROLE_MAX_LENGTH);
  const soul = limitedString(raw.soul, WISP_SOUL_MAX_LENGTH);
  if (!name?.trim() || role === undefined || soul === undefined) return invalid();
  const template: WispTemplate = { name, role, soul };
  if (raw.model !== undefined) {
    const model = modelSelection(raw.model);
    if (!model) return invalid();
    template.model = model;
  }
  // Version 1 had nothing else; fields it never wrote are ignored rather than trusted.
  if (version === 1) return { ok: true, template };

  if (raw.description !== undefined) {
    const description = limitedString(raw.description, WISP_TEMPLATE_DESCRIPTION_MAX_LENGTH);
    if (description === undefined) return invalid();
    if (description.trim()) template.description = description.trim();
  }
  // How the Wisp looks is a convenience: a look this app cannot draw falls back to the default.
  if (raw.appearance !== undefined) template.appearance = appearance(raw.appearance);
  if (typeof raw.color === "string") {
    const color = wispPaletteColor(raw.color);
    if (color) template.color = color;
  }
  if (raw.skills !== undefined) {
    const skills = parseSkills(raw.skills);
    if (!skills.ok) return skills;
    if (skills.skills.length) template.skills = skills.skills;
  }
  if (raw.setup !== undefined) {
    const setup = parseSetup(raw.setup);
    if (!setup) return invalid();
    template.setup = setup;
  }
  if (raw.access !== undefined) {
    const access = parseAccess(raw.access);
    if (!access) return invalid();
    template.access = access;
  }
  return { ok: true, template };
}

function invalid(error = INVALID_TEMPLATE): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function modelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined;
  const { providerId, modelId, maxOutputTokens, thinkingLevel } = value;
  if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) return undefined;
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) < 1)) {
    return undefined;
  }
  return {
    providerId,
    modelId,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: maxOutputTokens as number }),
    // A level this app does not know is dropped rather than failing the import.
    ...(isThinkingLevel(thinkingLevel) && thinkingLevel !== "off" ? { thinkingLevel } : {}),
  };
}

function appearance(value: unknown): WispAppearance {
  const saved = isRecord(value) ? value : {};
  const result = { ...DEFAULT_WISP_APPEARANCE };
  for (const key of Object.keys(WISP_APPEARANCE_AXES) as Array<keyof WispAppearance>) {
    const candidate = saved[key];
    if (isWispAppearanceValue(key, candidate)) (result as Record<string, unknown>)[key] = candidate;
  }
  return result;
}

/** Every skill must be one a Wisp could save; a template with a broken one says which. */
function parseSkills(value: unknown): { ok: true; skills: WispTemplateSkill[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > MAX_SKILLS_PER_WISP) return invalid();
  const skills: WispTemplateSkill[] = [];
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return invalid();
    const checked = checkSkillDocument(entry.contents);
    if (!checked.ok) return invalid(`Skill ${index + 1} in this template is not valid: ${checked.error}`);
    if (names.has(checked.draft.name)) return invalid(`This template has two skills named ${checked.draft.name}.`);
    names.add(checked.draft.name);
    skills.push({ contents: checked.contents });
  }
  return { ok: true, skills };
}

function parseSetup(value: unknown): WispTemplateSetup | undefined {
  if (!isRecord(value)) return undefined;
  const setup: WispTemplateSetup = {};
  if (value.quotaBytes !== undefined) {
    const { quotaBytes } = value;
    if (quotaBytes !== null && (typeof quotaBytes !== "number" || !WORKSPACE_QUOTA_PRESETS.includes(quotaBytes))) {
      return undefined;
    }
    setup.quotaBytes = quotaBytes;
  }
  if (value.executionMode !== undefined) {
    if (!EXECUTION_MODES.includes(value.executionMode as ExecutionMode)) return undefined;
    setup.executionMode = value.executionMode as ExecutionMode;
  }
  return setup;
}

const FILE_CATEGORIES: ReadonlyArray<WorkspaceFileCategory> = ["create_file", "modify_file"];
const BEHAVIORS: ReadonlyArray<ToolPolicyBehavior> = ["allow", "ask", "block"];
const MCP_SERVER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MCP_SERVER_NAME_MAX_LENGTH = 120;

function parseAccess(value: unknown): WispTemplateAccess | undefined {
  if (!isRecord(value)) return undefined;
  const access: WispTemplateAccess = {};
  if (value.files !== undefined) {
    if (!isRecord(value.files)) return undefined;
    const files: Partial<Record<WorkspaceFileCategory, ToolPolicyBehavior>> = {};
    for (const [category, behavior] of Object.entries(value.files)) {
      if (!FILE_CATEGORIES.includes(category as WorkspaceFileCategory)) return undefined;
      if (!BEHAVIORS.includes(behavior as ToolPolicyBehavior)) return undefined;
      files[category as WorkspaceFileCategory] = behavior as ToolPolicyBehavior;
    }
    access.files = files;
  }
  if (value.allowEverything !== undefined) {
    if (typeof value.allowEverything !== "boolean") return undefined;
    access.allowEverything = value.allowEverything;
  }
  if (value.plugins !== undefined) {
    if (!Array.isArray(value.plugins)) return undefined;
    const plugins: Array<{ pluginId: PluginId; access: "read" | "write" }> = [];
    for (const entry of value.plugins) {
      if (!isRecord(entry) || (entry.access !== "read" && entry.access !== "write")) return undefined;
      if (typeof entry.pluginId !== "string") return undefined;
      // A plugin this app does not have is left out, as a newer app's would be.
      if (!(PLUGIN_IDS as ReadonlyArray<string>).includes(entry.pluginId)) continue;
      if (plugins.some(({ pluginId }) => pluginId === entry.pluginId)) return undefined;
      plugins.push({ pluginId: entry.pluginId as PluginId, access: entry.access });
    }
    access.plugins = plugins;
  }
  if (value.mcpServers !== undefined) {
    if (!Array.isArray(value.mcpServers)) return undefined;
    const servers: Array<{ serverId: string; name: string; access: "use_with_approval" | "allow_all" }> = [];
    for (const entry of value.mcpServers) {
      if (!isRecord(entry) || (entry.access !== "use_with_approval" && entry.access !== "allow_all")) return undefined;
      if (typeof entry.serverId !== "string" || !MCP_SERVER_ID.test(entry.serverId)) return undefined;
      const name = limitedString(entry.name, MCP_SERVER_NAME_MAX_LENGTH);
      if (!name?.trim()) return undefined;
      if (servers.some(({ serverId }) => serverId === entry.serverId)) return undefined;
      servers.push({ serverId: entry.serverId, name: name.trim(), access: entry.access });
    }
    access.mcpServers = servers;
  }
  return access;
}
