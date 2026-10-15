import { isMcpToolAlias, mcpServerAliasPrefix } from "./mcp.js";
import { PLUGIN_TOOL_CATALOG } from "./plugin-tools/index.js";
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
  /** Manages the Wisp's jobs (ADR 019); offered only where jobs can run. */
  jobs?: boolean;
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
  {
    name: "run_command",
    label: "Run command",
    activityLabel: "Running a command…",
    category: "container_command",
  },
  {
    name: "process",
    label: "Background process",
    activityLabel: "Checking a background process…",
    category: "container_command",
  },
  { name: "save_skill", label: "Save skill", activityLabel: "Saving a skill…", category: "save_skill" },
  // Job tools are offered only where jobs can run, so they are not among the tools every Wisp has.
  {
    name: "schedule_job",
    label: "Schedule job",
    activityLabel: "Scheduling a job…",
    category: "schedule_job",
    jobs: true,
  },
  { name: "list_jobs", label: "List jobs", activityLabel: "Checking jobs…", category: "read", jobs: true },
  { name: "update_job", label: "Update job", activityLabel: "Updating a job…", category: "schedule_job", jobs: true },
  { name: "cancel_job", label: "Cancel job", activityLabel: "Cancelling a job…", category: "schedule_job", jobs: true },
  ...PLUGIN_TOOL_CATALOG,
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

/** Tools every Wisp has. Container tools are not: only Wisps whose commands run in a container get them. */
export const BUILTIN_TOOL_NAMES = TOOL_CATALOG.filter(
  ({ pluginId, pluginIds, category, jobs }) => !pluginId && !pluginIds && category !== "container_command" && !jobs,
).map(({ name }) => name);

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
