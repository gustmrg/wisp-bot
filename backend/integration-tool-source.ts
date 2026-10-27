import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import { createHash } from "node:crypto";

import type { ToolMetadata } from "../shared/tool-catalog.js";

/**
 * Asynchronous tool source returning a trusted snapshot: definitions the Pi
 * session can register, application-owned display metadata, the names currently
 * active for this Wisp, and a revision that changes whenever the visible set
 * changes. The Pi session can only adopt definitions from a snapshot; dynamic
 * tools become available by rebuilding the session with a newer snapshot.
 */
export interface IntegrationToolSnapshot {
  definitions: ReadonlyArray<ToolDefinition>;
  metadata: ReadonlyArray<SnapshotToolMetadata>;
  activeNames: ReadonlyArray<string>;
  /**
   * Source-scoped revision. It must change whenever the visible active set OR
   * any returned definition changes, so schema changes replace the old wrapper
   * instead of dispatching stale calls to a changed server.
   */
  revision: string;
  /**
   * Instructions that come with granted integrations, such as an MCP preset's
   * skill. They are offered like the Wisp's own skills and grant nothing.
   */
  skills?: ReadonlyArray<IntegrationSkill>;
}

/** An application-owned skill; a Wisp's own skill with the same name takes precedence. */
export interface IntegrationSkill {
  name: string;
  description: string;
  instructions: string;
}

/** Safe display metadata for a dynamically discovered tool. */
export interface SnapshotToolMetadata {
  name: string;
  label: string;
  activityLabel: string;
  category: ToolMetadata["category"];
  /** Owning server for MCP tools; absent for bundled plugins. */
  mcpServerId?: string;
  /** Original server-side tool name, when the alias was derived from one. */
  sourceName?: string;
  /**
   * The integration the tool belongs to, as the person named or knows it
   * ("Linear", "GitHub"); set for plugin and MCP tools, which a Wisp with many
   * of them finds with tool_search (ADR 034).
   */
  group?: string;
}

/**
 * The Wisp a tool runs for, and the conversation it runs in. Grants,
 * permissions, and settings belong to the Wisp; approval cards and the
 * workspace to the conversation. In a Wisp's own conversation the two IDs are
 * the same; in a circle they differ (ADR 011).
 */
export interface AgentScope {
  conversationId: string;
  wispId: string;
}

/** A Wisp in its own conversation, which shares the Wisp's ID. */
export function ownConversation(wispId: string): AgentScope {
  return { conversationId: wispId, wispId };
}

export interface IntegrationToolSource {
  getSnapshot(scope: AgentScope): Promise<IntegrationToolSnapshot>;
}

/**
 * Combines sources into one snapshot. Definitions must not collide: a source
 * may never shadow built-ins, bundled plugin tools, or another source's tools.
 */
export class CompositeIntegrationToolSource implements IntegrationToolSource {
  private readonly sources: ReadonlyArray<IntegrationToolSource>;

  constructor(sources: ReadonlyArray<IntegrationToolSource>) {
    this.sources = sources;
  }

  async getSnapshot(scope: AgentScope): Promise<IntegrationToolSnapshot> {
    const snapshots = await Promise.all(this.sources.map((source) => source.getSnapshot(scope)));
    const seen = new Set<string>();
    const definitions: ToolDefinition[] = [];
    const metadata: SnapshotToolMetadata[] = [];
    const activeNames: string[] = [];
    const skills = new Map<string, IntegrationSkill>();
    for (const snapshot of snapshots) {
      for (const skill of snapshot.skills ?? []) if (!skills.has(skill.name)) skills.set(skill.name, skill);
      for (const definition of snapshot.definitions) {
        if (seen.has(definition.name)) {
          throw new Error(`Integration tool name collision: ${definition.name}`);
        }
        seen.add(definition.name);
        definitions.push(definition);
      }
      metadata.push(...snapshot.metadata);
      for (const name of snapshot.activeNames) {
        if (!seen.has(name)) continue;
        if (!activeNames.includes(name)) activeNames.push(name);
      }
    }
    return {
      definitions,
      metadata,
      activeNames,
      ...(skills.size ? { skills: [...skills.values()] } : {}),
      // Definition changes (fingerprints) and grant changes both surface here
      // through the source revisions; names alone would miss schema changes.
      revision: snapshotRevision([...activeNames, ...snapshots.map(({ revision }) => revision)]),
    };
  }
}

/** Stable revision derived only from the effective visible set and sources. */
export function snapshotRevision(parts: ReadonlyArray<string>): string {
  return createHash("sha256")
    .update(JSON.stringify([...parts].sort()))
    .digest("hex");
}
