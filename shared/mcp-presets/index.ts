import { ATLASSIAN_MCP_PRESET } from "./atlassian.js";
import { GITHUB_MCP_PRESET } from "./github.js";
import { GITLAB_MCP_PRESET } from "./gitlab.js";
import { MCP_PRESET_IDS, type McpPreset, type McpPresetId, type McpPresetToolsets } from "./types.js";

export * from "./types.js";
export { ATLASSIAN_MCP_PRESET, GITHUB_MCP_PRESET, GITLAB_MCP_PRESET };

export const MCP_PRESETS: Readonly<Record<McpPresetId, McpPreset>> = {
  github: GITHUB_MCP_PRESET,
  gitlab: GITLAB_MCP_PRESET,
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

/**
 * The endpoint for an instance at this address: the instance's MCP path after
 * any path it is served under. An address without a scheme means HTTPS.
 * Undefined when the address is not a plain URL. A preset without instances
 * always has its own endpoint.
 */
export function presetInstanceEndpoint(preset: McpPreset, address: string): string | undefined {
  if (!preset.instance) return preset.endpoint;
  const trimmed = address.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${preset.instance.path}`;
}

/** The instance address a saved endpoint was made from. */
export function presetInstanceAddress(preset: McpPreset, endpoint: string): string {
  const path = preset.instance?.path;
  return path && endpoint.endsWith(path) ? endpoint.slice(0, -path.length) : endpoint;
}

/** A page of the hosted instance, such as where tokens are made, on the instance at this address. */
export function presetInstancePage(preset: McpPreset, address: string, hostedPage: string): string {
  const endpoint = preset.instance ? presetInstanceEndpoint(preset, address) : undefined;
  if (!endpoint) return hostedPage;
  const page = new URL(hostedPage);
  return `${presetInstanceAddress(preset, endpoint)}${page.pathname}${page.search}`;
}
