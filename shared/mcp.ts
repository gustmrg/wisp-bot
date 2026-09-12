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
 * Deterministic dispatch alias for a server tool. The immutable server ID is
 * embedded so a rename cannot change identities and two servers cannot shadow
 * each other or the built-in tools.
 */
export function mcpToolAlias(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return normalized || "server";
}

export function isMcpToolAlias(value: string): boolean {
  return value.startsWith("mcp_") && value.length <= 128 && ALIAS_PATTERN.test(value);
}
