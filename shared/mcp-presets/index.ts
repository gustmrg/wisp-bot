import { ATLASSIAN_MCP_PRESET } from "./atlassian.js";
import { GITHUB_MCP_PRESET } from "./github.js";
import { MCP_PRESET_IDS, type McpPreset, type McpPresetId, type McpPresetToolsets } from "./types.js";

export * from "./types.js";
export { ATLASSIAN_MCP_PRESET, GITHUB_MCP_PRESET };

export const MCP_PRESETS: Readonly<Record<McpPresetId, McpPreset>> = {
  github: GITHUB_MCP_PRESET,
  atlassian: ATLASSIAN_MCP_PRESET,
};

export function isMcpPresetId(value: unknown): value is McpPresetId {
  return typeof value === "string" && (MCP_PRESET_IDS as ReadonlyArray<string>).includes(value);
}

/** The toolset header value for a selection; required toolsets come first. */
export function presetToolsetHeaderValue(toolsets: McpPresetToolsets, selected: ReadonlyArray<string>): string {
  const chosen = toolsets.options.map(({ id }) => id).filter((id) => selected.includes(id));
  return [...toolsets.required, ...chosen].join(",");
}

/** The selected toolsets read back from a saved header value; unknown entries are ignored. */
export function presetToolsetsFromHeader(toolsets: McpPresetToolsets, value: string | undefined): string[] {
  if (value === undefined) return toolsets.options.filter((toolset) => toolset.default).map(({ id }) => id);
  const entries = value.split(",").map((entry) => entry.trim());
  return toolsets.options.map(({ id }) => id).filter((id) => entries.includes(id));
}
