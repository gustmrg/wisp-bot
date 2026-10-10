export const PLUGIN_IDS = ["web-search", "linear", "firecrawl", "tavily", "exa"] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];
export type PluginAccess = "none" | "read" | "write";

export const PLUGIN_CATEGORIES = [
  { id: "web", name: "Web & research" },
  { id: "productivity", name: "Productivity" },
] as const;

/** Web capabilities shared by several providers; each Wisp picks one provider per capability. */
export const WEB_CAPABILITIES = [
  { id: "search", name: "Search the web", shortName: "Search", toolName: "web_search" },
  { id: "read", name: "Read web pages", shortName: "Page reading", toolName: "web_read" },
] as const;
export type WebCapability = (typeof WEB_CAPABILITIES)[number]["id"];
export type WebProviders = Record<WebCapability, PluginId | null>;

export interface PluginCatalogEntry {
  id: PluginId;
  name: string;
  category: (typeof PLUGIN_CATEGORIES)[number]["id"];
  credentialLabel: string;
  /** Provider page where the user creates the API key. */
  credentialUrl: string;
  description: string;
  supportsWrite: boolean;
  /** Shared web capabilities this plugin can provide. */
  capabilities: ReadonlyArray<WebCapability>;
}

// The "web-search" ID predates the other web providers and is kept so saved grants stay valid.
export const PLUGIN_CATALOG: ReadonlyArray<PluginCatalogEntry> = [
  {
    id: "web-search",
    name: "Brave Search",
    category: "web",
    credentialLabel: "Brave Search API key",
    credentialUrl: "https://api-dashboard.search.brave.com/app/keys",
    description: "Search the web with Brave Search and return sources.",
    supportsWrite: false,
    capabilities: ["search"],
  },
  {
    id: "linear",
    category: "productivity",
    credentialLabel: "Linear personal API key",
    credentialUrl: "https://linear.app/settings/account/security",
    name: "Linear",
    description: "Find, read, create, update, and comment on Linear issues.",
    supportsWrite: true,
    capabilities: [],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "web",
    credentialLabel: "Firecrawl API key",
    credentialUrl: "https://www.firecrawl.dev/app/api-keys",
    description: "Search the web and read pages as Markdown with Firecrawl.",
    supportsWrite: false,
    capabilities: ["search", "read"],
  },
  {
    id: "tavily",
    name: "Tavily",
    category: "web",
    credentialLabel: "Tavily API key",
    credentialUrl: "https://app.tavily.com/home",
    description: "Search the web and extract page content with Tavily.",
    supportsWrite: false,
    capabilities: ["search", "read"],
  },
  {
    id: "exa",
    name: "Exa",
    category: "web",
    credentialLabel: "Exa API key",
    credentialUrl: "https://dashboard.exa.ai/api-keys",
    description: "Find relevant sources and read web pages with Exa.",
    supportsWrite: false,
    capabilities: ["search", "read"],
  },
];

export function pluginCatalogEntry(pluginId: PluginId): PluginCatalogEntry {
  return PLUGIN_CATALOG.find(({ id }) => id === pluginId) as PluginCatalogEntry;
}

/** Web providers are granted through capabilities instead of individual access levels. */
export function isWebProvider(pluginId: PluginId): boolean {
  return pluginCatalogEntry(pluginId).capabilities.length > 0;
}

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
  /** Provider preselected for each capability; null when no connected provider supplies it. */
  defaultProviders: WebProviders;
  credentialError?: string;
}

export interface PluginRequest {
  pluginId: PluginId;
}
export interface SavePluginSettingsRequest extends PluginRequest {
  enabled: boolean;
  apiKey?: string;
}
export interface SavePluginDefaultsRequest {
  defaultProviders: WebProviders;
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
  /** Provider used for each web capability; null means the capability is off. */
  webProviders: WebProviders;
}
export interface SaveWispPluginAccessRequest {
  conversationId: string;
  revision: string;
  grants: ReadonlyArray<PluginGrant>;
  /**
   * Explicit provider per capability. Each provider must also be granted `read`.
   * Without it, the Wisp falls back to catalog order among granted providers.
   */
  webProviders?: WebProviders;
}
