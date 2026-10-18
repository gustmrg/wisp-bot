import { PLUGIN_CATALOG, WEB_CAPABILITIES } from "../plugins.js";
import type { ToolMetadata } from "../tool-catalog.js";
import { GMAIL_TOOL_METADATA } from "./gmail.js";
import { GOOGLE_CALENDAR_TOOL_METADATA } from "./google-calendar.js";
import { GOOGLE_DRIVE_TOOL_METADATA } from "./google-drive.js";
import { LINEAR_TOOL_METADATA } from "./linear.js";
import { FIRECRAWL_SCRAPE_METADATA, WEB_READ_METADATA, WEB_SEARCH_METADATA } from "./web.js";

/** Web plugins that list the capability backed by this shared tool. */
function webProviders(toolName: string) {
  const capability = WEB_CAPABILITIES.find((item) => item.toolName === toolName)?.id;
  return PLUGIN_CATALOG.filter(({ capabilities }) => capability && capabilities.includes(capability)).map(
    ({ id }) => id,
  );
}

/** Catalog entries for every bundled plugin tool, built from the metadata each plugin declares. */
export const PLUGIN_TOOL_CATALOG: ReadonlyArray<ToolMetadata> = [
  { ...WEB_READ_METADATA, pluginIds: webProviders(WEB_READ_METADATA.name) },
  { ...FIRECRAWL_SCRAPE_METADATA, pluginId: "firecrawl" },
  { ...WEB_SEARCH_METADATA, pluginIds: webProviders(WEB_SEARCH_METADATA.name) },
  ...Object.values(LINEAR_TOOL_METADATA).map((metadata): ToolMetadata => ({ ...metadata, pluginId: "linear" })),
  ...Object.values(GOOGLE_CALENDAR_TOOL_METADATA).map(
    (metadata): ToolMetadata => ({ ...metadata, pluginId: "google-calendar" }),
  ),
  ...Object.values(GMAIL_TOOL_METADATA).map((metadata): ToolMetadata => ({ ...metadata, pluginId: "gmail" })),
  ...Object.values(GOOGLE_DRIVE_TOOL_METADATA).map(
    (metadata): ToolMetadata => ({ ...metadata, pluginId: "google-drive" }),
  ),
];
