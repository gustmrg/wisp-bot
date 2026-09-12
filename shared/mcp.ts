/**
 * Remote MCP server connections. The first release supports Streamable HTTP
 * endpoints only; local stdio servers are rejected at every boundary.
 */
export const MCP_AUTH_MODES = ["none", "header", "oauth"] as const;
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

/** Distinguishes configured, connected, needs sign-in, and unavailable connections. */
export type McpConnectionState = "configured" | "connected" | "needs_sign_in" | "unavailable";

/** First-release Wisp grant for an MCP server. Every call still requires approval. */
export type McpAccess = "none" | "use_with_approval";

export interface McpToolSummary {
  /** Original tool name reported by the server. */
  name: string;
  /** App-generated dispatch alias built from the immutable server ID. */
  alias: string;
  /** Application-owned display label; server prose is descriptive data only. */
  label: string;
  /** Bounded description from the server. */
  description: string;
  /** Fingerprint of the tool definition used for change review. */
  fingerprint: string;
}

export interface McpServerSummary {
  serverId: string;
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  enabled: boolean;
  state: McpConnectionState;
  headerConfigured: boolean;
  /** Header name is configuration, not a secret, and is safe to display. */
  headerName?: string;
  lastDiscoveredAt: string | null;
  tools: ReadonlyArray<McpToolSummary>;
}

export interface McpSettingsView {
  secureStorageAvailable: boolean;
  servers: ReadonlyArray<McpServerSummary>;
  credentialError?: string;
}

export interface SaveMcpServerRequest {
  /** Omit to add a new server; the backend assigns the immutable ID. */
  serverId?: string;
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  enabled?: boolean;
  /** Header authentication target; required for the header mode. */
  headerName?: string;
  /** Omit to keep the saved header value when editing. */
  headerValue?: string;
}

export interface McpServerRequest {
  serverId: string;
}

export interface TestMcpConnectionRequest {
  /** Omit to test a draft configuration that has not been saved yet. */
  serverId?: string;
  endpoint: string;
  authMode: McpAuthMode;
  headerName?: string;
  headerValue?: string;
}

export interface McpConnectionResult {
  message: string;
}

export interface McpGrant {
  serverId: string;
  access: McpAccess;
}

export interface WispMcpAccessView {
  conversationId: string;
  revision: string;
  grants: ReadonlyArray<McpGrant>;
}

export interface SaveWispMcpAccessRequest extends WispMcpAccessView {}

const ALIAS_PATTERN = /^mcp_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Model-facing tool names are capped at 64 characters by several providers
 * (OpenAI among them). The alias budget below keeps the total at or under 64
 * even after a disambiguation suffix: 4 ("mcp_") + 12 (server hash) + 1 + 42
 * (tool slug) = 59, + 1 + 4 (hash suffix) = 64.
 */
const ALIAS_MAX_LENGTH = 64;
const SERVER_HASH_CHARACTERS = 12;
const TOOL_SLUG_MAX_CHARACTERS = 42;

/**
 * Stable, dependency-free 32-bit FNV-1a. Shared code runs in the renderer too,
 * so node:crypto is not available here.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashHex(value: string, characters: number): string {
  const mixed = `${value.length}:${value}`;
  const first = fnv1a(mixed).toString(16).padStart(8, "0");
  const second = fnv1a(`wisp-mcp#${mixed}`).toString(16).padStart(8, "0");
  return `${first}${second}`.slice(0, characters);
}

/** Alias prefix owned by one server: derived from its immutable ID. */
export function mcpServerAliasPrefix(serverId: string): string {
  return `mcp_${hashHex(serverId, SERVER_HASH_CHARACTERS)}`;
}

/**
 * Deterministic base dispatch alias for a server tool. The immutable server ID
 * is embedded (hashed and bounded) so a rename cannot change identities and two
 * servers cannot shadow each other or the built-in tools. Distinct original
 * names can still normalize onto one base (e.g. "search.users" vs
 * "search_users"); callers must disambiguate with disambiguateMcpAlias.
 */
export function mcpToolAlias(serverId: string, toolName: string): string {
  const toolSlug = slug(toolName).slice(0, TOOL_SLUG_MAX_CHARACTERS);
  return `${mcpServerAliasPrefix(serverId)}_${toolSlug}`;
}

/**
 * Stable disambiguation for a colliding base alias: a short hash of the
 * original server-side name keeps distinct tools distinct regardless of
 * discovery order while staying within the provider name limit.
 */
export function disambiguateMcpAlias(baseAlias: string, toolName: string): string {
  const suffix = hashHex(toolName, 4);
  const trimmed = baseAlias.slice(0, ALIAS_MAX_LENGTH - suffix.length - 1);
  return `${trimmed}_${suffix}`;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return normalized || "tool";
}

export function isMcpToolAlias(value: string): boolean {
  return value.startsWith("mcp_") && value.length <= ALIAS_MAX_LENGTH && ALIAS_PATTERN.test(value);
}
