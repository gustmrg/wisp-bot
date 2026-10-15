import type { PluginToolMetadata } from "./types.js";

/** Shared web tools; each web plugin provides them for the capabilities it lists in PLUGIN_CATALOG. */
export const WEB_SEARCH_METADATA = {
  name: "web_search",
  label: "Search web",
  activityLabel: "Searching the web…",
  category: "search",
} as const satisfies PluginToolMetadata;

export const WEB_READ_METADATA = {
  name: "web_read",
  label: "Read web page",
  activityLabel: "Reading a web page…",
  category: "read",
} as const satisfies PluginToolMetadata;

// Preserve display metadata for saved conversations using the old name.
export const FIRECRAWL_SCRAPE_METADATA = {
  name: "firecrawl_scrape",
  label: "Read web page",
  activityLabel: "Reading a web page…",
  category: "read",
} as const satisfies PluginToolMetadata;
