import { createHash } from "node:crypto";

import { disambiguateMcpAlias, mcpToolAlias } from "../shared/mcp.js";
import { humanizeToolName } from "../shared/tool-catalog.js";
import { WispBackendError } from "./backend-error.js";
import { convertMcpToolResult, type McpSdkTool } from "./mcp-bridge.js";
import {
  MAX_TOOL_DESCRIPTION_CHARACTERS,
  MAX_TOOL_SCHEMA_JSON_BYTES,
  MAX_TOOL_SNAPSHOT_TOOLS,
  TOOL_NAME_PATTERN,
} from "./mcp-validation.js";

const MAX_ARGUMENT_JSON_BYTES = 200_000;
const MAX_SUMMARY_ARGUMENT_CHARACTERS = 60;
const MAX_TOOL_LABEL_CHARACTERS = 60;
const SECRET_KEY_PATTERN = /token|secret|password|authorization|credential|api[-_]?key/i;

/** A reviewed tool definition; its fingerprint is what grants and approvals are bound to. */
export interface McpToolRecord {
  name: string;
  alias: string;
  label: string;
  description: string;
  fingerprint: string;
  inputSchema: unknown;
}

/**
 * A server tool's label, in words. Two tools that would read the same keep their
 * own names from the second on, so an approval never makes one look like the other.
 */
export function mcpToolLabel(name: string, taken: Set<string>): string {
  const words = boundedText(humanizeToolName(name), MAX_TOOL_LABEL_CHARACTERS);
  const label = taken.has(words) ? boundedText(name, MAX_TOOL_LABEL_CHARACTERS) : words;
  taken.add(label);
  return label;
}

/**
 * The reviewed tool set of a server: valid, bounded definitions with unique
 * aliases. A server without one usable tool is a configuration error.
 */
export function buildToolSnapshot(tools: ReadonlyArray<McpSdkTool>, serverId: string): McpToolRecord[] {
  const records: McpToolRecord[] = [];
  const seenNames = new Set<string>();
  const usedAliases = new Set<string>();
  const usedLabels = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) continue;
    if (seenNames.has(tool.name)) continue;
    const schema = boundedSchema(tool.inputSchema);
    if (schema === undefined) continue;
    seenNames.add(tool.name);
    // Distinct names like "search.users" and "search_users" normalize onto
    // the same slug; keep both with a stable, name-derived suffix.
    let alias = mcpToolAlias(serverId, tool.name);
    if (usedAliases.has(alias)) {
      alias = disambiguateMcpAlias(alias, tool.name);
      if (usedAliases.has(alias)) continue;
    }
    usedAliases.add(alias);
    const description = boundedText(tool.description ?? "", MAX_TOOL_DESCRIPTION_CHARACTERS);
    records.push({
      name: tool.name,
      alias,
      label: mcpToolLabel(tool.name, usedLabels),
      description,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([tool.name, description, schema]))
        .digest("hex"),
      inputSchema: schema,
    });
    if (records.length >= MAX_TOOL_SNAPSHOT_TOOLS) break;
  }
  if (!records.length) throw new WispBackendError("invalid_configuration", "This server exposes no usable tools.");
  return records;
}

export function toolInputSchema(schema: unknown): Record<string, unknown> {
  if (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    (schema as { type?: unknown }).type === "object"
  ) {
    return schema as Record<string, unknown>;
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

/** Minimal validation against the reviewed schema; dispatch uses the original name. */
export function validateToolArguments(tool: McpToolRecord, args: unknown): Record<string, unknown> {
  const json = JSON.stringify(args ?? {});
  if (json === undefined || Buffer.byteLength(json) > MAX_ARGUMENT_JSON_BYTES) {
    throw new WispBackendError("invalid_request", "The tool arguments are too large.");
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new WispBackendError("invalid_request", "The tool arguments must be an object.");
  }
  const schema = tool.inputSchema as { required?: unknown } | undefined;
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]) : [];
  const record = args as Record<string, unknown>;
  for (const key of required) {
    if (typeof key === "string" && !(key in record)) {
      throw new WispBackendError("invalid_request", `The tool arguments are missing "${key}".`);
    }
  }
  return record;
}

export function summarizeArguments(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length >= 6) {
      parts.push("…");
      break;
    }
    const display = SECRET_KEY_PATTERN.test(key)
      ? "[redacted]"
      : typeof value === "string"
        ? truncate(value, MAX_SUMMARY_ARGUMENT_CHARACTERS)
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : Array.isArray(value) || (value && typeof value === "object")
            ? "[structured value]"
            : "null";
    parts.push(`${key}: ${display}`);
  }
  return parts.join(", ") || "no arguments";
}

export function convertResult(result: unknown): string {
  const converted = convertMcpToolResult(result);
  if (converted.isError) {
    // An MCP isError result must surface as a failed tool call, never as
    // successful activity in Pi.
    throw new WispBackendError("internal_error", boundedErrorText(converted.text), false);
  }
  return converted.text;
}

function boundedSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  let json: string;
  try {
    json = JSON.stringify(schema);
  } catch {
    return undefined;
  }
  if (json === undefined || Buffer.byteLength(json) > MAX_TOOL_SCHEMA_JSON_BYTES) return undefined;
  return schema;
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maxLength);
}

function boundedErrorText(value: string): string {
  return truncate(value, 500) || "The MCP tool reported an error.";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
