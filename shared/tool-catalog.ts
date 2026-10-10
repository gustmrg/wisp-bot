import { isMcpToolAlias, mcpServerAliasPrefix } from "./mcp.js";
import type { PluginId } from "./plugins.js";
import type { ToolActionCategory } from "./tool-policy.js";

export interface ToolMetadata {
  name: string;
  label: string;
  activityLabel: string;
  category: ToolActionCategory;
  pluginId?: PluginId;
  /** Providers of a shared capability; this does not grant plugin access. */
  pluginIds?: ReadonlyArray<PluginId>;
  /** Set for dynamically discovered MCP tools; references the owning server. */
  mcpServerId?: string;
}

export interface DynamicToolMetadataInput {
  name: string;
  label: string;
  activityLabel?: string;
  /**
   * The immutable MCP server ID the alias must be derived from. Entries
   * without a server ID (for example bundled plugin metadata) are skipped.
   */
  mcpServerId?: string;
  /**
   * The original server-side tool name the alias must be derived from. When
   * omitted, the alias must already be a well-formed derivation target.
   */
  sourceName?: string;
}

// This catalog is the application-owned boundary for tool discovery and display.
// A plugin grant still needs to be checked by the backend before every execution.
export const TOOL_CATALOG: ReadonlyArray<ToolMetadata> = [
  { name: "read", label: "Read file", activityLabel: "Reading files…", category: "read" },
  { name: "grep", label: "Search workspace", activityLabel: "Searching the workspace…", category: "search" },
  { name: "find", label: "Search workspace", activityLabel: "Searching the workspace…", category: "search" },
  { name: "ls", label: "List files", activityLabel: "Inspecting the workspace…", category: "read" },
  { name: "edit", label: "Edit file", activityLabel: "Editing a file…", category: "modify_file" },
  { name: "write", label: "Write file", activityLabel: "Writing a file…", category: "create_file" },
  {
    name: "search_history",
    label: "Search history",
    activityLabel: "Searching conversation history…",
    category: "search",
  },
  { name: "use_skill", label: "Use skill", activityLabel: "Reading a skill…", category: "read" },
  { name: "save_skill", label: "Save skill", activityLabel: "Saving a skill…", category: "save_skill" },
  {
    name: "web_read",
    label: "Read web page",
    activityLabel: "Reading a web page…",
    category: "read",
    pluginIds: ["firecrawl", "tavily", "exa"],
  },
  // Preserve display metadata for saved conversations using the old name.
  {
    name: "firecrawl_scrape",
    label: "Read web page",
    activityLabel: "Reading a web page…",
    category: "read",
    pluginId: "firecrawl",
  },
  {
    name: "web_search",
    label: "Search web",
    activityLabel: "Searching the web…",
    category: "search",
    pluginIds: ["web-search", "firecrawl", "tavily", "exa"],
  },
  {
    name: "linear_search_issues",
    label: "Search Linear issues",
    activityLabel: "Searching Linear issues…",
    category: "search",
    pluginId: "linear",
  },
  {
    name: "linear_get_issue",
    label: "Read Linear issue",
    activityLabel: "Reading a Linear issue…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_list_teams",
    label: "List Linear teams",
    activityLabel: "Listing Linear teams…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_list_statuses",
    label: "List Linear statuses",
    activityLabel: "Listing Linear statuses…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_list_comments",
    label: "List Linear comments",
    activityLabel: "Reading Linear comments…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_list_projects",
    label: "List Linear projects",
    activityLabel: "Listing Linear projects…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_list_labels",
    label: "List Linear labels",
    activityLabel: "Listing Linear labels…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_list_users",
    label: "List Linear users",
    activityLabel: "Listing Linear users…",
    category: "read",
    pluginId: "linear",
  },
  {
    name: "linear_create_issue",
    label: "Create Linear issue",
    activityLabel: "Creating a Linear issue…",
    category: "external_write",
    pluginId: "linear",
  },
  {
    name: "linear_update_issue",
    label: "Update Linear issue",
    activityLabel: "Updating a Linear issue…",
    category: "external_write",
    pluginId: "linear",
  },
  {
    name: "linear_add_comment",
    label: "Comment on Linear issue",
    activityLabel: "Commenting on a Linear issue…",
    category: "external_write",
    pluginId: "linear",
  },
];

const metadataByName = new Map(TOOL_CATALOG.map((metadata) => [metadata.name, metadata]));

// Backend-validated metadata for dynamically discovered MCP tools. Entries are
// keyed by the app-generated alias and re-registered (idempotently) whenever a
// trusted tool snapshot changes. Names are never accepted from the renderer or
// from arbitrary prefixes: each alias must sit under the registering server's
// own prefix, derived from its immutable ID. Disambiguation suffixes (added
// when distinct tool names normalize onto one base) stay valid here.
const MAX_DYNAMIC_LABEL_CHARACTERS = 80;
const ALIAS_REMAINDER_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function registerDynamicToolMetadata(entries: ReadonlyArray<DynamicToolMetadataInput>): void {
  for (const entry of entries) {
    if (!entry.mcpServerId) continue;
    const alias = entry.name;
    if (!isMcpToolAlias(alias)) continue;
    const prefix = mcpServerAliasPrefix(entry.mcpServerId);
    const remainder = alias.slice(prefix.length + 1);
    if (!alias.startsWith(`${prefix}_`) || !remainder || !ALIAS_REMAINDER_PATTERN.test(remainder)) continue;
    const label = boundedText(entry.label, MAX_DYNAMIC_LABEL_CHARACTERS);
    if (!label) continue;
    metadataByName.set(alias, {
      name: alias,
      label,
      activityLabel: boundedText(entry.activityLabel ?? `Using ${label}…`, MAX_DYNAMIC_LABEL_CHARACTERS),
      category: "integration_call",
      mcpServerId: entry.mcpServerId,
    });
  }
}

export function unregisterDynamicToolMetadata(serverId?: string): void {
  for (const [name, metadata] of metadataByName) {
    if (metadata.mcpServerId && (!serverId || metadata.mcpServerId === serverId)) metadataByName.delete(name);
  }
}

/** Resets dynamic registrations; used by tests to isolate catalog state. */
export function resetDynamicToolMetadata(): void {
  unregisterDynamicToolMetadata();
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maxLength);
}

export const BUILTIN_TOOL_NAMES = TOOL_CATALOG.filter(({ pluginId, pluginIds }) => !pluginId && !pluginIds).map(
  ({ name }) => name,
);

export function getToolMetadata(name: string): ToolMetadata | undefined {
  return metadataByName.get(name);
}

/**
 * Display fallback for an MCP tool alias with no registered metadata (for
 * example after the server was removed). This is descriptive only: it must not
 * be treated as proof that a name belongs to a live integration.
 */
export function describeMcpAlias(name: string): ToolMetadata | undefined {
  if (!isMcpToolAlias(name)) return undefined;
  let remainder = name.replace(/^mcp_/, "");
  // Skip the bounded server-hash segment when present for a readable label.
  remainder = remainder.replace(/^[0-9a-f]{12}_/, "");
  const label = remainder
    .replaceAll("_", " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
  return {
    name,
    label: label || name,
    activityLabel: `Calling ${label || "an integration tool"}…`,
    category: "integration_call",
  };
}
