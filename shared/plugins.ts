export const PLUGIN_IDS = ["web-search", "linear", "firecrawl", "tavily", "exa", "google-calendar"] as const;
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
  /**
   * Set for plugins that sign in through the browser with the user's own OAuth
   * client instead of an API key. `credentialLabel` and `credentialUrl` then
   * name the client and the page that creates it.
   */
  signIn?: PluginSignInInfo;
}

export interface PluginSignInInfo {
  /** What the user creates for the client, shown above the client fields. */
  clientHelp: string;
  /** Step-by-step setup guide for the client. */
  setupUrl: string;
}

/** The Google plugins' setup guide; each plugin signs in with an OAuth client the user creates. */
const GOOGLE_SETUP_URL =
  "https://github.com/gustmrg/wisp-bot/blob/main/docs/plugins.md#setting-up-a-google-oauth-client";

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
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "productivity",
    credentialLabel: "Google Cloud credentials",
    credentialUrl: "https://console.cloud.google.com/apis/credentials",
    description: "See your calendars and availability, and create and update events.",
    supportsWrite: true,
    capabilities: [],
    signIn: {
      clientHelp:
        "Google Calendar signs in with an OAuth client you create in your own Google Cloud project: a Desktop app client, with the Google Calendar API turned on.",
      setupUrl: GOOGLE_SETUP_URL,
    },
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
  /** A sign-in plugin's account, such as an email address, when the provider reports one. */
  account?: string;
  /** A sign-in plugin whose access was revoked or expired: its tools stay off until it signs in again. */
  needsSignIn?: boolean;
  /** A browser sign-in is waiting; it can be cancelled from any window. */
  signInPending?: boolean;
  /** The sign-in page to open by hand while a sign-in waits for its result to be pasted back. */
  signInUrl?: string;
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
/**
 * Signs a plugin in through the browser. The OAuth client is required for the
 * first sign-in and replaces the saved one when given; omit it to sign in again.
 */
export interface StartPluginSignInRequest extends PluginRequest {
  clientId?: string;
  clientSecret?: string;
}
/** Completes a waiting sign-in with the address the browser was redirected to. */
export interface FinishPluginSignInRequest extends PluginRequest {
  redirectUrl: string;
}
export interface PluginConnectionResult {
  message: string;
}
export interface PluginGrant {
  pluginId: PluginId;
  access: PluginAccess;
  /** With "write" access, the Wisp runs every write action of the plugin without asking. */
  alwaysAllowAll?: boolean;
  /**
   * Write tools this Wisp runs without asking. Only an approval card can add
   * one. When saving, omit to keep the current list; a list can only remove.
   */
  alwaysAllowedTools?: ReadonlyArray<string>;
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
