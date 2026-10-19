import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWispMcpServer, type WispMcpTool } from "../backend/claude-code/wisp-mcp-server.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const echo: WispMcpTool = {
  name: "echo",
  description: "Returns its text.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: vi.fn(async (_id: string, params: never) => ({
    content: [{ type: "text", text: `wisp:${(params as { text: string }).text}` }],
  })),
};

async function connect(tools: () => Promise<ReadonlyArray<WispMcpTool>>) {
  const validate = vi.fn((tool: WispMcpTool, call: { arguments: unknown }) => {
    const args = call.arguments as Record<string, unknown>;
    if (tool.name === "echo" && typeof args.text !== "string") throw new Error("text: must be a string");
    return args;
  });
  const server = createWispMcpServer({ tools, workspaceDirectory: "/data/workspaces/w1", validate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, validate };
}

describe("createWispMcpServer", () => {
  it("lists Wisp's tools with their own JSON Schema", async () => {
    const { client } = await connect(async () => [echo]);

    const { tools } = await client.listTools();

    expect(tools).toEqual([
      {
        name: "echo",
        description: "Returns its text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ]);
  });

  it("runs a tool with Claude Code's tool call ID and the workspace as its context", async () => {
    const { client } = await connect(async () => [echo]);

    const result = await client.callTool({
      name: "echo",
      arguments: { text: "ping" },
      _meta: { "claudecode/toolUseId": "toolu_123" },
    });

    expect(result).toEqual({ content: [{ type: "text", text: "wisp:ping" }] });
    expect(echo.execute).toHaveBeenCalledWith(
      "toolu_123",
      { text: "ping" },
      expect.any(AbortSignal),
      undefined,
      expect.objectContaining({ cwd: "/data/workspaces/w1" }),
    );
  });

  it("checks arguments the way Pi does and reports errors to the model", async () => {
    const failing: WispMcpTool = {
      ...echo,
      name: "fails",
      execute: async () => {
        throw new Error("Denied by the person.");
      },
    };
    const { client } = await connect(async () => [echo, failing]);

    await expect(client.callTool({ name: "echo", arguments: { text: 42 } })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "text: must be a string" }],
    });
    await expect(client.callTool({ name: "fails", arguments: { text: "x" } })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Denied by the person." }],
    });
  });

  it("refuses a tool the Wisp no longer has, at once", async () => {
    let granted: WispMcpTool[] = [echo];
    const { client } = await connect(async () => granted);
    await client.listTools();

    granted = [];

    await expect(client.callTool({ name: "echo", arguments: { text: "x" } })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "The tool echo is not available to this Wisp." }],
    });
  });

  it("passes images on and drops content MCP cannot carry", async () => {
    const image: WispMcpTool = {
      ...echo,
      name: "image",
      execute: async () => ({
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "unknown" },
          { type: "text", text: "caption" },
        ],
      }),
    };
    const { client } = await connect(async () => [image]);

    await expect(client.callTool({ name: "image", arguments: { text: "x" } })).resolves.toEqual({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "caption" },
      ],
    });
  });
});
