import { MCP_ACCESS_LEVELS, MCP_AUTH_MODES, type McpAccess, type McpAuthMode, type McpGrant } from "../shared/mcp.js";
import { isMcpPresetId, type McpPresetId } from "../shared/mcp-presets.js";
import { WispBackendError } from "./backend-error.js";

/**
 * Maximum tools accepted from one server, shared by bridge discovery and
 * snapshot persistence. 128 keeps headroom for large real servers (Linear
 * exposes 66) while bounding per-session context growth. It is not a
 * per-Wisp bound: some models accept fewer tools in total, and a request that
 * exceeds a model's limit is reported by describeProviderError.
 */
export const MAX_TOOL_SNAPSHOT_TOOLS = 128;
export const MAX_TOOL_DESCRIPTION_CHARACTERS = 700;
export const MAX_TOOL_SCHEMA_JSON_BYTES = 8_000;
export const MAX_TOOL_RESULT_TEXT_CHARACTERS = 64_000;
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_TOOL_TIMEOUT_MS = 120_000;
/** Keys that would configure a local process; rejected, never honored. */
const FORBIDDEN_LAUNCH_KEYS = ["command", "args", "arguments", "env", "environment", "cwd", "workingDirectory"];
const SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_EXTRA_HEADERS = 8;
const MAX_EXTRA_HEADER_VALUE_LENGTH = 1_024;
/** Set by the transport or the protocol; a configured value would break or spoof them. */
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
  "user-agent",
]);
/** Extra headers are stored in plain configuration, so credentials must use the authentication header. */
const CREDENTIAL_HEADER_PATTERN = /auth|cookie|token|secret|key|password|session/i;
/** Original MCP tool names accepted from servers. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,128}$/;

export function mcpRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMcpRequest();
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some((key) => !keys.includes(key))) throw invalidMcpRequest();
  return record;
}

export function rejectLocalLaunchConfiguration(record: Record<string, unknown>): void {
  if (FORBIDDEN_LAUNCH_KEYS.some((key) => key in record)) {
    throw new WispBackendError(
      "invalid_request",
      "Local MCP servers are not supported. Provide an HTTPS endpoint URL instead.",
    );
  }
}

export function parseMcpEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) throw invalidMcpRequest();
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidMcpRequest();
  }
  if (url.protocol !== "https:") {
    throw new WispBackendError("invalid_request", "MCP endpoints must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new WispBackendError("invalid_request", "MCP endpoint URLs must not contain credentials.");
  }
  return url.toString();
}

export function parseMcpServerName(value: unknown): string {
  if (typeof value !== "string") throw invalidMcpRequest();
  const name = value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!name) throw new WispBackendError("invalid_request", "Enter a connection name.");
  return name;
}

export function parseMcpAuthMode(value: unknown): McpAuthMode {
  if (typeof value !== "string" || !MCP_AUTH_MODES.includes(value as McpAuthMode)) throw invalidMcpRequest();
  return value as McpAuthMode;
}

export function parseMcpHeaderName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256 || !HEADER_NAME_PATTERN.test(value)) throw invalidMcpRequest();
  return value;
}

export function parseMcpSecretValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 8_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw invalidMcpRequest();
  return value.trim();
}

/**
 * Non-secret headers sent with every request, such as a server's option
 * selectors. They are stored and displayed as configuration, so names that
 * look like credentials are refused: those belong in the encrypted
 * authentication header.
 */
export function parseMcpExtraHeaders(
  value: unknown,
  authHeaderName?: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const record = mcpRecord(value);
  const entries = Object.entries(record);
  if (entries.length > MAX_EXTRA_HEADERS) {
    throw new WispBackendError("invalid_request", `Add at most ${MAX_EXTRA_HEADERS} additional headers.`);
  }
  const seen = new Set<string>(authHeaderName ? [authHeaderName.toLowerCase()] : []);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    parseMcpHeaderName(name);
    const lower = name.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(lower) || lower.startsWith("proxy-")) {
      throw new WispBackendError("invalid_request", `The ${name} header is set by Wisp and cannot be configured.`);
    }
    if (CREDENTIAL_HEADER_PATTERN.test(name)) {
      throw new WispBackendError(
        "invalid_request",
        `${name} looks like a credential. Use the authentication header for secrets; additional headers are not encrypted.`,
      );
    }
    if (seen.has(lower)) throw new WispBackendError("invalid_request", `The ${name} header is set more than once.`);
    seen.add(lower);
    if (
      typeof headerValue !== "string" ||
      headerValue.length > MAX_EXTRA_HEADER_VALUE_LENGTH ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/.test(headerValue)
    )
      throw invalidMcpRequest();
    headers[name] = headerValue.trim();
  }
  return headers;
}

export function parseMcpPreset(value: unknown): McpPresetId | undefined {
  if (value === undefined) return undefined;
  if (!isMcpPresetId(value)) throw invalidMcpRequest();
  return value;
}

export function parseMcpServerId(value: unknown): string {
  if (typeof value !== "string" || !SERVER_ID_PATTERN.test(value)) throw invalidMcpRequest();
  return value;
}

export function parseSaveMcpServer(value: unknown): {
  serverId?: string;
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  enabled: boolean;
  headerName?: string;
  headerValue?: string;
  extraHeaders?: Readonly<Record<string, string>>;
  preset?: McpPresetId;
} {
  const raw = mcpRecord(value, [
    "serverId",
    "name",
    "endpoint",
    "authMode",
    "enabled",
    "headerName",
    "headerValue",
    "extraHeaders",
    "preset",
  ]);
  rejectLocalLaunchConfiguration(raw);
  const serverId = raw.serverId === undefined ? undefined : parseMcpServerId(raw.serverId);
  const authMode = parseMcpAuthMode(raw.authMode);
  const headerName = parseMcpHeaderName(raw.headerName);
  const headerValue = parseMcpSecretValue(raw.headerValue);
  if (authMode === "header" && (!headerName || (headerValue === undefined && !serverId))) {
    throw new WispBackendError("invalid_request", "Header authentication requires a header name and value.");
  }
  const extraHeaders = parseMcpExtraHeaders(raw.extraHeaders, authMode === "header" ? headerName : undefined);
  const preset = parseMcpPreset(raw.preset);
  // A preset is chosen when the connection is added and never changes.
  if (preset && serverId) throw invalidMcpRequest();
  return {
    ...(serverId ? { serverId } : {}),
    name: parseMcpServerName(raw.name),
    endpoint: parseMcpEndpoint(raw.endpoint),
    authMode,
    enabled: raw.enabled === true,
    ...(headerName ? { headerName } : {}),
    ...(headerValue !== undefined ? { headerValue } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
    ...(preset ? { preset } : {}),
  };
}

export function parseMcpServerRequest(value: unknown): { serverId: string } {
  return { serverId: parseMcpServerId(mcpRecord(value, ["serverId"]).serverId) };
}

const MAX_REDIRECT_URL_LENGTH = 8192;

export function parseFinishMcpSignIn(value: unknown): { serverId: string; redirectUrl: string } {
  const record = mcpRecord(value, ["serverId", "redirectUrl"]);
  const redirectUrl = typeof record.redirectUrl === "string" ? record.redirectUrl.trim() : "";
  if (!redirectUrl || redirectUrl.length > MAX_REDIRECT_URL_LENGTH) {
    throw new WispBackendError("invalid_request", "Paste the address of the page the sign-in sent you to.");
  }
  return { serverId: parseMcpServerId(record.serverId), redirectUrl };
}

export function parseTestMcpConnection(value: unknown): {
  serverId?: string;
  endpoint: string;
  authMode: McpAuthMode;
  headerName?: string;
  headerValue?: string;
  extraHeaders?: Readonly<Record<string, string>>;
} {
  const raw = mcpRecord(value, ["serverId", "endpoint", "authMode", "headerName", "headerValue", "extraHeaders"]);
  rejectLocalLaunchConfiguration(raw);
  const serverId = raw.serverId === undefined ? undefined : parseMcpServerId(raw.serverId);
  const authMode = parseMcpAuthMode(raw.authMode);
  const headerName = parseMcpHeaderName(raw.headerName);
  const headerValue = parseMcpSecretValue(raw.headerValue);
  // The header name may fall back to the saved server's configuration when
  // testing a stored connection.
  if (authMode === "header" && !headerName && !serverId) throw invalidMcpRequest();
  const extraHeaders = parseMcpExtraHeaders(raw.extraHeaders, authMode === "header" ? headerName : undefined);
  return {
    ...(serverId ? { serverId } : {}),
    endpoint: parseMcpEndpoint(raw.endpoint),
    authMode,
    ...(headerName ? { headerName } : {}),
    ...(headerValue !== undefined ? { headerValue } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
  };
}

export function parseMcpConversation(value: unknown): { conversationId: string } {
  const raw = mcpRecord(value, ["conversationId"]);
  if (typeof raw.conversationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(raw.conversationId))
    throw invalidMcpRequest();
  return { conversationId: raw.conversationId };
}

export function parseMcpGrants(value: unknown): McpGrant[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_SNAPSHOT_TOOLS) throw invalidMcpRequest();
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = mcpRecord(entry, ["serverId", "access", "alwaysAllowedTools"]);
    const serverId = parseMcpServerId(raw.serverId);
    if (
      seen.has(serverId) ||
      typeof raw.access !== "string" ||
      !(MCP_ACCESS_LEVELS as ReadonlyArray<string>).includes(raw.access)
    )
      throw invalidMcpRequest();
    seen.add(serverId);
    const alwaysAllowedTools = parseAlwaysAllowedTools(raw.alwaysAllowedTools);
    return { serverId, access: raw.access as McpAccess, ...(alwaysAllowedTools ? { alwaysAllowedTools } : {}) };
  });
}

function parseAlwaysAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_TOOL_SNAPSHOT_TOOLS ||
    value.some((name) => typeof name !== "string" || !TOOL_NAME_PATTERN.test(name))
  )
    throw invalidMcpRequest();
  return [...new Set(value as string[])];
}

export function parseSaveWispMcpAccess(value: unknown): {
  conversationId: string;
  revision: string;
  grants: McpGrant[];
} {
  const raw = mcpRecord(value, ["conversationId", "revision", "grants"]);
  if (typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)) throw invalidMcpRequest();
  return {
    ...parseMcpConversation({ conversationId: raw.conversationId }),
    revision: raw.revision,
    grants: parseMcpGrants(raw.grants),
  };
}

export function invalidMcpRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The MCP connection configuration is invalid.");
}
