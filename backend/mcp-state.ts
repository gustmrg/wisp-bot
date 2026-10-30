import { randomUUID } from "node:crypto";

import { MCP_ACCESS_LEVELS, type McpAccess, type McpAuthMode } from "../shared/mcp.js";
import { isMcpPresetId, type McpPresetId } from "../shared/mcp-presets/index.js";
import { invalidMcpRequest, mcpRecord, parseMcpExtraHeaders } from "./mcp-validation.js";
import { mcpToolLabel, type McpToolRecord } from "./mcp-tools.js";

export interface McpServerRecord {
  serverId: string;
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  enabled: boolean;
  /** Bumped whenever endpoint, authentication, or account identity changes. */
  configGeneration: number;
  headerName?: string;
  /** Non-secret headers sent with every request; changing them re-discovers tools but keeps grants. */
  extraHeaders?: Record<string, string>;
  preset?: McpPresetId;
  snapshot?: { discoveredAt: string; tools: McpToolRecord[] };
  lastConnection?: { state: "connected" | "unavailable"; at: string; message?: string };
}

/** Tool name → fingerprint of the definition the user always allowed. */
export type AlwaysAllowedTools = Record<string, string>;

/** The persisted MCP settings: connections, their reviewed tools, and each Wisp's grants. */
export interface McpState {
  schemaVersion: 2;
  revision: string;
  servers: Record<string, McpServerRecord>;
  grants: Record<string, Record<string, McpAccess>>;
  /** Per Wisp and server; pruned on every commit to granted, unchanged tools. */
  alwaysAllowed: Record<string, Record<string, AlwaysAllowedTools>>;
}

export function defaultState(): McpState {
  return { schemaVersion: 2, revision: randomUUID(), servers: {}, grants: {}, alwaysAllowed: {} };
}

/**
 * Keeps only tools still granted and unchanged: a removed or re-identified
 * connection, revoked access, or a new tool definition drops the permission,
 * so a changed tool always asks again.
 */
export function prunedAlwaysAllowed(state: McpState): McpState["alwaysAllowed"] {
  const pruned: McpState["alwaysAllowed"] = {};
  for (const [sessionId, servers] of Object.entries(state.alwaysAllowed)) {
    for (const [serverId, tools] of Object.entries(servers)) {
      const server = state.servers[serverId];
      if (!server || (state.grants[sessionId]?.[serverId] ?? "none") === "none") continue;
      const kept = Object.entries(tools).filter(([name, fingerprint]) =>
        server.snapshot?.tools.some((tool) => tool.name === name && tool.fingerprint === fingerprint),
      );
      if (kept.length) (pruned[sessionId] ??= {})[serverId] = Object.fromEntries(kept);
    }
  }
  return pruned;
}

/** Reads saved settings; anything malformed is refused rather than repaired. */
export function normalizeState(value: unknown): McpState {
  // Version 1 predates always-allowed tools and migrates with none.
  const raw = mcpRecord(value, ["schemaVersion", "revision", "servers", "grants", "alwaysAllowed"]);
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw invalidMcpRequest();
  const normalized = defaultState();
  if (typeof raw.revision === "string" && /^[a-f0-9-]{36}$/.test(raw.revision)) normalized.revision = raw.revision;
  const servers = mcpRecord(raw.servers);
  for (const [serverId, entry] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(serverId)) throw invalidMcpRequest();
    const record = mcpRecord(entry, [
      "serverId",
      "name",
      "endpoint",
      "authMode",
      "enabled",
      "configGeneration",
      "headerName",
      "extraHeaders",
      "preset",
      "snapshot",
      "lastConnection",
    ]);
    if (record.serverId !== serverId) throw invalidMcpRequest();
    const snapshotRaw = record.snapshot;
    let snapshot: McpServerRecord["snapshot"];
    if (snapshotRaw && typeof snapshotRaw === "object" && !Array.isArray(snapshotRaw)) {
      const snapshotRecord = mcpRecord(snapshotRaw, ["discoveredAt", "tools"]);
      if (typeof snapshotRecord.discoveredAt !== "string" || !Array.isArray(snapshotRecord.tools))
        throw invalidMcpRequest();
      const tools: McpToolRecord[] = [];
      const labels = new Set<string>();
      for (const tool of snapshotRecord.tools) {
        const toolRecord = mcpRecord(tool, ["name", "alias", "label", "description", "fingerprint", "inputSchema"]);
        if (
          typeof toolRecord.name !== "string" ||
          typeof toolRecord.alias !== "string" ||
          typeof toolRecord.label !== "string" ||
          typeof toolRecord.description !== "string" ||
          typeof toolRecord.fingerprint !== "string"
        )
          throw invalidMcpRequest();
        tools.push({
          name: toolRecord.name,
          alias: toolRecord.alias,
          // From the name again, so a server discovered by an older build reads the same as a new one.
          label: mcpToolLabel(toolRecord.name, labels),
          description: toolRecord.description,
          fingerprint: toolRecord.fingerprint,
          inputSchema: toolRecord.inputSchema,
        });
      }
      snapshot = { discoveredAt: snapshotRecord.discoveredAt, tools };
    }
    let lastConnection: McpServerRecord["lastConnection"];
    if (record.lastConnection && typeof record.lastConnection === "object") {
      const connectionRecord = mcpRecord(record.lastConnection, ["state", "at", "message"]);
      if (
        (connectionRecord.state !== "connected" && connectionRecord.state !== "unavailable") ||
        typeof connectionRecord.at !== "string"
      )
        throw invalidMcpRequest();
      lastConnection = {
        state: connectionRecord.state,
        at: connectionRecord.at,
        ...(typeof connectionRecord.message === "string" ? { message: connectionRecord.message } : {}),
      };
    }
    normalized.servers[serverId] = {
      serverId,
      name: typeof record.name === "string" ? record.name : serverId,
      endpoint: typeof record.endpoint === "string" ? record.endpoint : "",
      authMode: record.authMode === "oauth" || record.authMode === "header" ? record.authMode : "none",
      enabled: record.enabled === true,
      configGeneration: typeof record.configGeneration === "number" ? record.configGeneration : 1,
      ...(typeof record.headerName === "string" ? { headerName: record.headerName } : {}),
      ...(record.extraHeaders === undefined ? {} : { extraHeaders: { ...parseMcpExtraHeaders(record.extraHeaders) } }),
      ...(isMcpPresetId(record.preset) ? { preset: record.preset } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(lastConnection ? { lastConnection } : {}),
    };
  }
  const grants = mcpRecord(raw.grants);
  for (const [sessionId, value] of Object.entries(grants)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sessionId)) throw invalidMcpRequest();
    const sessionGrants = mcpRecord(value);
    const normalizedGrants: Record<string, McpAccess> = {};
    for (const [serverId, access] of Object.entries(sessionGrants)) {
      if (typeof access !== "string" || !(MCP_ACCESS_LEVELS as ReadonlyArray<string>).includes(access))
        throw invalidMcpRequest();
      normalizedGrants[serverId] = access as McpAccess;
    }
    normalized.grants[sessionId] = normalizedGrants;
  }
  if (raw.schemaVersion === 2) {
    for (const [sessionId, value] of Object.entries(mcpRecord(raw.alwaysAllowed))) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(sessionId)) throw invalidMcpRequest();
      for (const [serverId, tools] of Object.entries(mcpRecord(value))) {
        for (const [name, fingerprint] of Object.entries(mcpRecord(tools))) {
          if (typeof fingerprint !== "string") throw invalidMcpRequest();
          ((normalized.alwaysAllowed[sessionId] ??= {})[serverId] ??= {})[name] = fingerprint;
        }
      }
    }
  }
  normalized.alwaysAllowed = prunedAlwaysAllowed(normalized);
  return normalized;
}
