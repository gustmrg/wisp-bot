export const PLUGIN_IDS = ["web-search", "linear", "firecrawl"] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];
export type PluginAccess = "none" | "read" | "write";

export const PLUGIN_CATEGORIES = [
  { id: "web", name: "Web & research" },
  { id: "productivity", name: "Productivity" },
] as const;

export const PLUGIN_CATALOG = [
  {
    id: "web-search",
    name: "Web search",
    category: "web",
    credentialLabel: "Brave Search API key",
    description: "Search the web with Brave Search and return sources.",
    supportsWrite: false,
  },
  {
    id: "linear",
    category: "productivity",
    credentialLabel: "Linear personal API key",
    name: "Linear",
    description: "Find, read, create, and update Linear issues.",
    supportsWrite: true,
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "web",
    credentialLabel: "Firecrawl API key",
    description: "Search the web and read pages as Markdown with Firecrawl.",
    supportsWrite: false,
  },
] as const;

export interface PluginSummary {
  id: PluginId;
  name: string;
  description: string;
  supportsWrite: boolean;
  configured: boolean;
  enabled: boolean;
}

export interface PluginSettingsView {
  secureStorageAvailable: boolean;
  plugins: ReadonlyArray<PluginSummary>;
  credentialError?: string;
}

export interface PluginRequest {
  pluginId: PluginId;
}
export interface SavePluginSettingsRequest extends PluginRequest {
  enabled: boolean;
  apiKey?: string;
}
export interface TestPluginConnectionRequest extends PluginRequest {
  apiKey?: string;
}
export interface PluginConnectionResult {
  message: string;
}
export interface PluginGrant {
  pluginId: PluginId;
  access: PluginAccess;
}
export interface WispPluginAccessView {
  conversationId: string;
  revision: string;
  grants: ReadonlyArray<PluginGrant>;
}
export interface SaveWispPluginAccessRequest extends WispPluginAccessView {}
