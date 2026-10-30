import { describe, expect, it } from "vitest";

import { normalizeState } from "../backend/mcp-state.js";
import { buildToolSnapshot } from "../backend/mcp-tools.js";

const inputSchema = { type: "object", properties: {} };

describe("an MCP tool's label", () => {
  it("is its name in words", () => {
    const [tool] = buildToolSnapshot([{ name: "getEntry", inputSchema }], "server-a");

    expect(tool).toMatchObject({ name: "getEntry", label: "Get entry" });
  });

  it("stays the tool's own name when another tool already reads the same", () => {
    const tools = buildToolSnapshot(
      [
        { name: "getEntry", inputSchema },
        { name: "get_entry", inputSchema },
      ],
      "server-a",
    );

    expect(tools.map(({ label }) => label)).toEqual(["Get entry", "get_entry"]);
  });

  it("does not change what a remembered approval is bound to", () => {
    const [first] = buildToolSnapshot([{ name: "getEntry", description: "Reads", inputSchema }], "server-a");
    const [second] = buildToolSnapshot([{ name: "getEntry", description: "Writes", inputSchema }], "server-a");

    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it("is worked out again for a server discovered before labels were in words", () => {
    const [tool] = buildToolSnapshot([{ name: "getEntry", inputSchema }], "server-a");
    const state = normalizeState({
      schemaVersion: 2,
      servers: {
        "server-a": {
          serverId: "server-a",
          name: "Journal",
          snapshot: {
            discoveredAt: "2026-10-01T10:00:00.000Z",
            tools: [{ ...tool, label: "getEntry" }],
          },
        },
      },
      grants: {},
      alwaysAllowed: {},
    });

    expect(state.servers["server-a"]?.snapshot?.tools[0]).toMatchObject({
      label: "Get entry",
      alias: tool?.alias,
      fingerprint: tool?.fingerprint,
    });
  });
});
