import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { WISP_MCP_SERVER } from "./claude-code-launch.js";

/** Claude Code names the tool call an MCP request answers in its metadata. */
const TOOL_USE_ID_META = "claudecode/toolUseId";

/**
 * The part of a Pi tool definition the server uses. Wisp's tools authorize
 * themselves inside `execute` through the broker, so offering them here keeps
 * approval cards, lasting rules, and the audit exactly as they are on Pi.
 */
export interface WispMcpTool {
  name: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }> }>;
}

export interface WispMcpServerOptions {
  /** The tools a Wisp is offered now; asked again on every call, so a revoked grant applies at once. */
  tools: () => Promise<ReadonlyArray<WispMcpTool>>;
  /** The conversation's workspace, where Pi's file tools resolve paths. */
  workspaceDirectory: string;
  /** Pi's argument check, the same one a Pi session runs before a tool. */
  validate: (
    tool: WispMcpTool,
    toolCall: { type: "toolCall"; id: string; name: string; arguments: unknown },
  ) => unknown;
}

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Wisp's tools as an in-process MCP server for Claude Code, described with
 * their own JSON Schema. Claude Code calls them over the SDK's control
 * channel: there is no port, token, or file.
 */
export function createWispMcpServer(options: WispMcpServerOptions): McpServer {
  const mcp = new McpServer({ name: WISP_MCP_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  // Pi's file tools only read the working directory and whether the model sees images.
  const toolContext = { cwd: options.workspaceDirectory, model: { input: ["text", "image"] } };

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await options.tools()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: "object" },
    })),
  }));

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const tool = (await options.tools()).find((candidate) => candidate.name === name);
    if (!tool) return errorResult(`The tool ${name} is not available to this Wisp.`);
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const toolCallId = typeof meta?.[TOOL_USE_ID_META] === "string" ? (meta[TOOL_USE_ID_META] as string) : randomUUID();
    let params: unknown;
    try {
      const prepared = tool.prepareArguments
        ? tool.prepareArguments(request.params.arguments ?? {})
        : (request.params.arguments ?? {});
      params = options.validate(tool, { type: "toolCall", id: toolCallId, name, arguments: prepared });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "The tool arguments are invalid.");
    }
    try {
      const result = await tool.execute(toolCallId, params as never, extra.signal, undefined, toolContext);
      const content: ToolContent[] = [];
      for (const item of result.content) {
        if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
        else if (item.type === "image" && item.data && item.mimeType) {
          content.push({ type: "image", data: item.data, mimeType: item.mimeType });
        }
      }
      return { content };
    } catch (error) {
      return errorResult(error instanceof Error && error.message ? error.message : "The tool failed.");
    }
  });
  return mcp;
}
