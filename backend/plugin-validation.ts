import {
  CLAUDE_WEB_SEARCH,
  PLUGIN_IDS,
  PLUGIN_CATALOG,
  WEB_CAPABILITIES,
  pluginCatalogEntry,
  type PluginId,
  type PluginGrant,
  type SavePluginDefaultsRequest,
  type SavePluginSettingsRequest,
  type TestPluginConnectionRequest,
  type StartPluginSignInRequest,
  type FinishPluginSignInRequest,
  type SaveWispPluginAccessRequest,
  type WebProviders,
  type WispWebProviders,
} from "../shared/plugins.js";
import { getToolMetadata } from "../shared/tool-catalog.js";
import { WispBackendError } from "./backend-error.js";

export function pluginRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPluginRequest();
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some((key) => !keys.includes(key))) throw invalidPluginRequest();
  return record;
}

export function parsePluginId(value: unknown): PluginId {
  if (!PLUGIN_IDS.includes(value as PluginId)) throw invalidPluginRequest();
  return value as PluginId;
}

export function parsePluginRequest(value: unknown): { pluginId: PluginId } {
  return { pluginId: parsePluginId(pluginRecord(value, ["pluginId"]).pluginId) };
}

function parseKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 20_000 || /[\u0000-\u001f\u007f]/.test(value))
    throw invalidPluginRequest();
  return value.trim();
}

/**
 * A key with the instance address it belongs to. Plugins that connect to an
 * instance take both together; other plugins take no address.
 */
function parseConnection(pluginId: PluginId, raw: Record<string, unknown>): { apiKey?: string; endpoint?: string } {
  const apiKey = parseKey(raw.apiKey);
  const needsEndpoint = Boolean(pluginCatalogEntry(pluginId).serverAddress);
  if (raw.endpoint !== undefined && (!needsEndpoint || apiKey === undefined)) throw invalidPluginRequest();
  if (apiKey === undefined) return {};
  if (!needsEndpoint) return { apiKey };
  if (raw.endpoint === undefined) throw new WispBackendError("invalid_request", "Enter the address of the server.");
  return { apiKey, endpoint: parsePluginEndpoint(raw.endpoint) };
}

export function parseSavePluginSettings(value: unknown): SavePluginSettingsRequest {
  const raw = pluginRecord(value, ["pluginId", "enabled", "apiKey", "endpoint"]);
  if (typeof raw.enabled !== "boolean") throw invalidPluginRequest();
  const pluginId = parsePluginId(raw.pluginId);
  return { pluginId, enabled: raw.enabled, ...parseConnection(pluginId, raw) };
}

export function parseTestPluginConnection(value: unknown): TestPluginConnectionRequest {
  const raw = pluginRecord(value, ["pluginId", "apiKey", "endpoint"]);
  const pluginId = parsePluginId(raw.pluginId);
  return { pluginId, ...parseConnection(pluginId, raw) };
}

const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".internal", ".home.arpa", ".ts.net"];

/** Hosts on this network or a tailnet, where HTTP does not cross the internet. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A single-label name, such as "homeassistant", only resolves on the local network.
  if (/^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Tailscale and other carrier-grade NAT addresses.
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/**
 * The address of a plugin's own server: HTTPS anywhere, or HTTP on a local
 * network or tailnet, without credentials, query, or fragment. Returned
 * without a trailing slash so API paths can be appended.
 */
export function parsePluginEndpoint(value: unknown): string {
  const invalid = () =>
    new WispBackendError(
      "invalid_request",
      "Enter the server address, such as http://homeassistant.local:8123 or https://home.example.com.",
    );
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) throw invalid();
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid();
  if (url.username || url.password)
    throw new WispBackendError("invalid_request", "The server address must not contain a user name or password.");
  if (url.search || url.hash) throw invalid();
  if (url.protocol === "http:" && !isLocalHost(url.hostname))
    throw new WispBackendError(
      "invalid_request",
      "Use HTTPS for a server outside your local network; HTTP would send the token unencrypted.",
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const MAX_CLIENT_FIELD = 512;
const MAX_REDIRECT_URL_LENGTH = 8192;

function clientField(value: unknown, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_CLIENT_FIELD ||
    /[\u0000-\u001f\s]/.test(value.trim())
  )
    throw new WispBackendError("invalid_request", message);
  return value.trim();
}

export function parseStartPluginSignIn(value: unknown): StartPluginSignInRequest {
  const raw = pluginRecord(value, ["pluginId", "clientId", "clientSecret"]);
  const clientId = clientField(raw.clientId, "Enter the OAuth client ID.");
  const clientSecret = clientField(raw.clientSecret, "Enter the OAuth client secret.");
  if (clientSecret && !clientId) throw new WispBackendError("invalid_request", "Enter the OAuth client ID.");
  return {
    pluginId: parsePluginId(raw.pluginId),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

export function parseFinishPluginSignIn(value: unknown): FinishPluginSignInRequest {
  const raw = pluginRecord(value, ["pluginId", "redirectUrl"]);
  const redirectUrl = typeof raw.redirectUrl === "string" ? raw.redirectUrl.trim() : "";
  if (!redirectUrl || redirectUrl.length > MAX_REDIRECT_URL_LENGTH)
    throw new WispBackendError("invalid_request", "Paste the address of the page the sign-in sent you to.");
  return { pluginId: parsePluginId(raw.pluginId), redirectUrl };
}

export function parsePluginConversation(value: unknown): { conversationId: string } {
  const raw = pluginRecord(value, ["conversationId"]);
  if (typeof raw.conversationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(raw.conversationId))
    throw invalidPluginRequest();
  return { conversationId: raw.conversationId };
}

export function parseGrants(value: unknown): PluginGrant[] {
  if (!Array.isArray(value) || value.length > PLUGIN_IDS.length) throw invalidPluginRequest();
  const seen = new Set<PluginId>();
  return value.map((entry) => {
    const raw = pluginRecord(entry, ["pluginId", "access", "alwaysAllowAll", "alwaysAllowedTools"]);
    const pluginId = parsePluginId(raw.pluginId);
    if (
      seen.has(pluginId) ||
      typeof raw.access !== "string" ||
      !["none", "read", "write"].includes(raw.access) ||
      (!PLUGIN_CATALOG.find(({ id }) => id === pluginId)!.supportsWrite && raw.access === "write") ||
      (raw.alwaysAllowAll !== undefined && typeof raw.alwaysAllowAll !== "boolean")
    )
      throw invalidPluginRequest();
    seen.add(pluginId);
    const alwaysAllowedTools =
      raw.alwaysAllowedTools === undefined ? undefined : parsePluginToolNames(pluginId, raw.alwaysAllowedTools);
    return {
      pluginId,
      access: raw.access as PluginGrant["access"],
      ...(raw.alwaysAllowAll === true ? { alwaysAllowAll: true } : {}),
      ...(alwaysAllowedTools ? { alwaysAllowedTools } : {}),
    };
  });
}

/** Names of a plugin's own write tools, such as the ones a Wisp always runs without asking. */
export function parsePluginToolNames(pluginId: PluginId, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw invalidPluginRequest();
  for (const name of value) {
    const metadata = typeof name === "string" ? getToolMetadata(name) : undefined;
    if (!metadata || metadata.pluginId !== pluginId || metadata.category !== "external_write")
      throw invalidPluginRequest();
  }
  return [...new Set(value as string[])];
}

/** Parses one provider per web capability; each provider must supply that capability. */
export function parseWebProviders(value: unknown): WebProviders {
  const raw = pluginRecord(
    value,
    WEB_CAPABILITIES.map(({ id }) => id),
  );
  const providers = { search: null, read: null } as WebProviders;
  for (const { id: capability } of WEB_CAPABILITIES) {
    if (raw[capability] === null || raw[capability] === undefined) continue;
    const pluginId = parsePluginId(raw[capability]);
    if (!pluginCatalogEntry(pluginId).capabilities.includes(capability)) throw invalidPluginRequest();
    providers[capability] = pluginId;
  }
  return providers;
}

/** A Wisp's providers: search can also be Claude Code's own, which needs no grant. */
export function parseWispWebProviders(value: unknown): WispWebProviders {
  const raw = pluginRecord(
    value,
    WEB_CAPABILITIES.map(({ id }) => id),
  );
  const claude = raw.search === CLAUDE_WEB_SEARCH;
  const providers: WispWebProviders = parseWebProviders(claude ? { ...raw, search: null } : raw);
  if (claude) providers.search = CLAUDE_WEB_SEARCH;
  return providers;
}

export function parseSavePluginDefaults(value: unknown): SavePluginDefaultsRequest {
  return { defaultProviders: parseWebProviders(pluginRecord(value, ["defaultProviders"]).defaultProviders) };
}

export function parseSaveWispPluginAccess(value: unknown): SaveWispPluginAccessRequest {
  const raw = pluginRecord(value, ["conversationId", "revision", "grants", "webProviders"]);
  if (typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)) throw invalidPluginRequest();
  const grants = parseGrants(raw.grants);
  if (raw.webProviders === undefined)
    return { ...parsePluginConversation({ conversationId: raw.conversationId }), revision: raw.revision, grants };
  const webProviders = parseWispWebProviders(raw.webProviders);
  // A selected provider needs its own grant, so revocation and key replacement keep working per plugin.
  for (const pluginId of Object.values(webProviders))
    if (
      pluginId &&
      pluginId !== CLAUDE_WEB_SEARCH &&
      grants.find((grant) => grant.pluginId === pluginId)?.access !== "read"
    )
      throw invalidPluginRequest();
  return {
    ...parsePluginConversation({ conversationId: raw.conversationId }),
    revision: raw.revision,
    grants,
    webProviders,
  };
}

export function invalidPluginRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The plugin configuration is invalid.");
}
