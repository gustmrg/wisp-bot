import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import type { SnapshotToolMetadata } from "./integration-tool-source.js";
import { isSharedWebTool } from "./plugins/web.js";

/** Pi's tool that loads deferred tools for the next model call. */
export const TOOL_SEARCH_TOOL = "tool_search";

/**
 * Up to this many granted integration tools, a Wisp's model sees every one;
 * above it, it loads the ones it needs with tool_search (ADR 034). A plugin
 * or two stay as they were; a large MCP server, or several plugins, do not
 * fill every request with schemas.
 */
export const MAX_DECLARED_INTEGRATION_TOOLS = 12;

/** The integration tools a session declares only after tool_search loads them. */
export interface DeferredTools {
  names: ReadonlySet<string>;
  /** Each integration with deferred tools and how many, by name, for the system prompt. */
  groups: ReadonlyArray<{ name: string; tools: number }>;
}

export const NO_DEFERRED_TOOLS: DeferredTools = { names: new Set(), groups: [] };

/**
 * The granted plugin and MCP tools a Wisp finds with tool_search, or none
 * while it has few. Shared web tools stay declared: Wisps search the web
 * often, and the prompt tells them to use those tools by name.
 */
export function deferIntegrationTools(
  metadata: ReadonlyArray<SnapshotToolMetadata>,
  granted: ReadonlyArray<string>,
): DeferredTools {
  const grantedNames = new Set(granted);
  const deferrable = metadata.filter(
    ({ name, group }) => group !== undefined && grantedNames.has(name) && !isSharedWebTool(name),
  );
  if (deferrable.length <= MAX_DECLARED_INTEGRATION_TOOLS) return NO_DEFERRED_TOOLS;
  const counts = new Map<string, number>();
  for (const { group } of deferrable) counts.set(group!, (counts.get(group!) ?? 0) + 1);
  return {
    names: new Set(deferrable.map(({ name }) => name)),
    groups: [...counts]
      .map(([name, tools]) => ({ name, tools }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Marks a definition as deferred for Pi, in its integration's namespace, so
 * tool_search can rank it by the integration's name too.
 */
export function deferDefinition(definition: ToolDefinition, group: string | undefined): ToolDefinition {
  return {
    ...definition,
    exposure: "deferred",
    ...(group ? { namespace: { name: group, description: `${group} tools` } } : {}),
  };
}

/** What the system prompt says about deferred tools, so the model knows to search before giving up. */
export function deferredToolsSection(deferred: DeferredTools): string[] {
  if (deferred.names.size === 0) return [];
  const groups = deferred.groups.map(({ name, tools }) => `${name} (${tools} ${tools === 1 ? "tool" : "tools"})`);
  return [
    "## Tools you load when needed",
    `To keep requests small, the tools of these integrations are not listed until you load them: ${groups.join(", ")}.`,
    `When a request needs one of them, call ${TOOL_SEARCH_TOOL} with words for the action and the integration, such as "Linear create issue" or "calendar list events", then call the tool it loads. Search again with other words before saying you cannot do something with these integrations.`,
    "Tools you load stay available afterwards.",
  ];
}

/**
 * The tools a Pi session declares: every allowed tool except deferred ones,
 * which stay declared once tool_search has loaded them and while they are
 * still allowed.
 */
export function declaredTools(
  allowed: ReadonlyArray<string>,
  deferred: ReadonlySet<string>,
  loaded: ReadonlySet<string>,
): string[] {
  return allowed.filter((name) => !deferred.has(name) || loaded.has(name));
}

/** The tools a tool_search result says it loaded. */
export function toolSearchLoads(result: unknown): string[] {
  const loaded = (result as { details?: { loaded?: unknown } } | undefined)?.details?.loaded;
  return Array.isArray(loaded) ? loaded.filter((name): name is string => typeof name === "string") : [];
}
