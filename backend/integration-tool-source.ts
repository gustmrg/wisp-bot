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
}

export interface IntegrationToolSource {
  getSnapshot(conversationId: string): Promise<IntegrationToolSnapshot>;
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

  async getSnapshot(conversationId: string): Promise<IntegrationToolSnapshot> {
    const snapshots = await Promise.all(this.sources.map((source) => source.getSnapshot(conversationId)));
    const seen = new Set<string>();
    const definitions: ToolDefinition[] = [];
    const metadata: SnapshotToolMetadata[] = [];
    const activeNames: string[] = [];
    for (const snapshot of snapshots) {
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
