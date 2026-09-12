import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import { isMcpToolAlias, mcpToolAlias } from "../shared/mcp.js";
import {
  describeMcpAlias,
  getToolMetadata,
  registerDynamicToolMetadata,
  resetDynamicToolMetadata,
  unregisterDynamicToolMetadata,
  BUILTIN_TOOL_NAMES,
} from "../shared/tool-catalog.js";
import {
  CompositeIntegrationToolSource,
  snapshotRevision,
  type IntegrationToolSource,
  type IntegrationToolSnapshot,
} from "../electron/backend/integration-tool-source.js";

afterEach(() => {
  resetDynamicToolMetadata();
});

describe("dynamic tool catalog", () => {
  it("registers aliases derived from the immutable server ID and original tool name", () => {
    const serverId = "58ba17c5-4c75-4886-bf5a-d6efa5414b30";
    const alias = mcpToolAlias(serverId, "create_issue");
    expect(alias).toMatch(/^mcp_[a-z0-9_]+_create_issue$/);
    expect(isMcpToolAlias(alias)).toBe(true);

    registerDynamicToolMetadata([
      { name: alias, label: "Create issue", mcpServerId: serverId, sourceName: "create_issue" },
    ]);
    expect(getToolMetadata(alias)?.label).toBe("Create issue");
    expect(getToolMetadata(alias)?.category).toBe("integration_call");
    expect(getToolMetadata(alias)?.mcpServerId).toBe(serverId);
    // Built-ins and bundled plugin tools are never shadowed.
    for (const name of BUILTIN_TOOL_NAMES) expect(getToolMetadata(name)?.mcpServerId).toBeUndefined();
  });

  it("rejects entries whose alias does not match the derivation", () => {
    const serverId = "aaaa-bbbb";
    registerDynamicToolMetadata([
      // Wrong name for the claimed derivation.
      { name: "mcp_not_this_server_tool", label: "Fake", mcpServerId: serverId, sourceName: "tool" },
      // Not a well-formed alias at all.
      { name: "read", label: "Shadow read", mcpServerId: serverId },
      // No server ID.
      { name: "mcp_loose", label: "Loose", mcpServerId: "" } as never,
    ]);
    expect(getToolMetadata("mcp_not_this_server_tool")).toBeUndefined();
    expect(getToolMetadata("read")?.label).toBe("Read file");
    expect(getToolMetadata("mcp_loose")).toBeUndefined();
  });

  it("unregisters per server and keeps other servers' entries", () => {
    const aliasA = mcpToolAlias("server-a", "search");
    const aliasB = mcpToolAlias("server-b", "search");
    registerDynamicToolMetadata([
      { name: aliasA, label: "A search", mcpServerId: "server-a", sourceName: "search" },
      { name: aliasB, label: "B search", mcpServerId: "server-b", sourceName: "search" },
    ]);
    unregisterDynamicToolMetadata("server-a");
    expect(getToolMetadata(aliasA)).toBeUndefined();
    expect(getToolMetadata(aliasB)).toBeDefined();
  });

  it("describes aliases after removal as a display-only fallback", () => {
    const alias = mcpToolAlias("server-a", "create_issue");
    expect(getToolMetadata(alias)).toBeUndefined();
    const described = describeMcpAlias(alias);
    expect(described?.label).toContain("create issue");
    // The fallback must never validate arbitrary names.
    expect(describeMcpAlias("read")).toBeUndefined();
    expect(describeMcpAlias("mcp_with spaces!")).toBeUndefined();
  });
});

function sourceSnapshot(overrides: Partial<IntegrationToolSnapshot>): IntegrationToolSource {
  return {
    getSnapshot: vi.fn(async () => ({
      definitions: [],
      metadata: [],
      activeNames: [],
      revision: "r",
      ...overrides,
    })),
  };
}

describe("CompositeIntegrationToolSource", () => {
  it("merges definitions, metadata, and active names from all sources", async () => {
    const definition = { name: "mcp_a_search", execute: async () => undefined } as unknown as ToolDefinition;
    const composite = new CompositeIntegrationToolSource([
      sourceSnapshot({
        definitions: [definition],
        metadata: [
          {
            name: "mcp_a_search",
            label: "Search",
            activityLabel: "Searching…",
            category: "integration_call",
            mcpServerId: "a",
            sourceName: "search",
          },
        ],
        activeNames: ["mcp_a_search"],
        revision: "rev-a",
      }),
      sourceSnapshot({ activeNames: [], revision: "rev-b" }),
    ]);
    const snapshot = await composite.getSnapshot("wisp-1");
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.activeNames).toEqual(["mcp_a_search"]);
    expect(snapshot.metadata).toHaveLength(1);
  });

  it("rejects name collisions between sources instead of shadowing", async () => {
    const definition = { name: "mcp_a_search" } as unknown as ToolDefinition;
    const composite = new CompositeIntegrationToolSource([
      sourceSnapshot({ definitions: [definition], activeNames: ["mcp_a_search"] }),
      sourceSnapshot({ definitions: [definition], activeNames: ["mcp_a_search"] }),
    ]);
    await expect(composite.getSnapshot("wisp-1")).rejects.toThrow(/collision/);
  });

  it("changes the composite revision when a source revision changes even with identical names", async () => {
    const composite = new CompositeIntegrationToolSource([
      sourceSnapshot({ activeNames: ["mcp_a_search"], revision: "rev-1" }),
    ]);
    const before = await composite.getSnapshot("wisp-1");
    const changed = new CompositeIntegrationToolSource([
      sourceSnapshot({ activeNames: ["mcp_a_search"], revision: "rev-2" }),
    ]);
    const after = await changed.getSnapshot("wisp-1");
    expect(before.revision).not.toBe(after.revision);
  });

  it("derives the revision only from the provided parts", () => {
    expect(snapshotRevision(["a", "b"])).toBe(snapshotRevision(["b", "a"]));
    expect(snapshotRevision(["a", "b"])).not.toBe(snapshotRevision(["a", "c"]));
  });
});
