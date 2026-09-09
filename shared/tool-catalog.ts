import type { PluginId } from "./plugins.js";
import type { ToolActionCategory } from "./tool-policy.js";

export interface ToolMetadata {
  name: string;
  label: string;
  activityLabel: string;
  category: ToolActionCategory;
  pluginId?: PluginId;
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
    pluginId: "web-search",
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
];

const metadataByName = new Map(TOOL_CATALOG.map((metadata) => [metadata.name, metadata]));

export const BUILTIN_TOOL_NAMES = TOOL_CATALOG.filter(({ pluginId }) => !pluginId).map(({ name }) => name);

export function getToolMetadata(name: string): ToolMetadata | undefined {
  return metadataByName.get(name);
}
