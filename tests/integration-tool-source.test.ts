import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import { disambiguateMcpAlias, isMcpToolAlias, mcpServerAliasPrefix, mcpToolAlias } from "../shared/mcp.js";
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
} from "../backend/integration-tool-source.js";

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

  it("keeps aliases within provider name limits and distinct tools distinct", () => {
    const uuid = "58ba17c5-4c75-4886-bf5a-d6efa5414b30";
    // 36-character UUID plus this name exceeded 64 characters previously.
    const longAlias = mcpToolAlias(uuid, "get_pull_request_comments");
    expect(longAlias.length).toBeLessThanOrEqual(64);
    expect(isMcpToolAlias(longAlias)).toBe(true);

    // Distinct names normalize onto one base; stable disambiguation separates
    // them without depending on discovery order.
    const dot = mcpToolAlias(uuid, "search.users");
    const underscore = mcpToolAlias(uuid, "search_users");
    expect(dot).toBe(underscore);
    const dotDisambiguated = disambiguateMcpAlias(dot, "search.users");
    const underscoreDisambiguated = disambiguateMcpAlias(underscore, "search_users");
    expect(dotDisambiguated).not.toBe(underscoreDisambiguated);
    for (const alias of [dotDisambiguated, underscoreDisambiguated]) {
      expect(alias.length).toBeLessThanOrEqual(64);
      expect(isMcpToolAlias(alias)).toBe(true);
    }
  });

  it("registers disambiguated aliases under the owning server's prefix only", () => {
    const serverA = "58ba17c5-4c75-4886-bf5a-d6efa5414b30";
    const serverB = "0f0e0d0c-0b0a-0908-0706-050403020100";
    const base = mcpToolAlias(serverA, "search");
    const disambiguated = disambiguateMcpAlias(base, "search.users");
    registerDynamicToolMetadata([{ name: disambiguated, label: "Search users", mcpServerId: serverA }]);
    expect(getToolMetadata(disambiguated)?.label).toBe("Search users");
    expect(getToolMetadata(disambiguated)?.mcpServerId).toBe(serverA);

    // Another server cannot register names under server A's prefix, and a
    // derivation mismatch is still rejected.
    const foreign = `${mcpServerAliasPrefix(serverA)}_spoofed`;
    registerDynamicToolMetadata([{ name: foreign, label: "Spoofed", mcpServerId: serverB }]);
    expect(getToolMetadata(foreign)).toBeUndefined();
    registerDynamicToolMetadata([{ name: "mcp_wrong_tool", label: "Wrong", mcpServerId: serverA }]);
    expect(getToolMetadata("mcp_wrong_tool")).toBeUndefined();
  });

  it("describes aliases after removal as a display-only fallback", () => {
    const alias = mcpToolAlias("server-a", "create_issue");
    expect(getToolMetadata(alias)).toBeUndefined();
    const described = describeMcpAlias(alias);
    expect(described?.label).toBe("Create issue");
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
