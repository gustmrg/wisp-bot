import {
  PLUGIN_IDS,
  type PluginId,
  type PluginGrant,
  type SavePluginSettingsRequest,
  type TestPluginConnectionRequest,
  type SaveWispPluginAccessRequest,
} from "../../shared/plugins.js";
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

export function parseSavePluginSettings(value: unknown): SavePluginSettingsRequest {
  const raw = pluginRecord(value, ["pluginId", "enabled", "apiKey"]);
  if (typeof raw.enabled !== "boolean") throw invalidPluginRequest();
  const apiKey = parseKey(raw.apiKey);
  return { pluginId: parsePluginId(raw.pluginId), enabled: raw.enabled, ...(apiKey === undefined ? {} : { apiKey }) };
}

export function parseTestPluginConnection(value: unknown): TestPluginConnectionRequest {
  const raw = pluginRecord(value, ["pluginId", "apiKey"]);
  const apiKey = parseKey(raw.apiKey);
  return { pluginId: parsePluginId(raw.pluginId), ...(apiKey === undefined ? {} : { apiKey }) };
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
    const raw = pluginRecord(entry, ["pluginId", "access"]);
    const pluginId = parsePluginId(raw.pluginId);
    if (
      seen.has(pluginId) ||
      typeof raw.access !== "string" ||
      !["none", "read", "write"].includes(raw.access) ||
      (pluginId === "web-search" && raw.access === "write")
    )
      throw invalidPluginRequest();
    seen.add(pluginId);
    return { pluginId, access: raw.access as PluginGrant["access"] };
  });
}

export function parseSaveWispPluginAccess(value: unknown): SaveWispPluginAccessRequest {
  const raw = pluginRecord(value, ["conversationId", "revision", "grants"]);
  if (typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)) throw invalidPluginRequest();
  return {
    ...parsePluginConversation({ conversationId: raw.conversationId }),
    revision: raw.revision,
    grants: parseGrants(raw.grants),
  };
}

export function invalidPluginRequest(): WispBackendError {
  return new WispBackendError("invalid_request", "The plugin configuration is invalid.");
}
