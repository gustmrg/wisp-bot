import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeCodeQueryOptions } from "../backend/claude-code/claude-code-launch.js";
import type { ClaudeCodeQuery } from "../backend/claude-code/claude-code-session.js";
import { ClaudeCodeSessionFactory } from "../backend/claude-code/claude-code-session-factory.js";
import type { ClaudeCodeStatusService } from "../backend/claude-code/claude-code-status.js";
import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { ClaudeCodeStatusView } from "../shared/claude-code.js";
import { DEFAULT_CONTEXT_POLICY } from "../shared/context-policy.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const READY: ClaudeCodeStatusView = { state: "ready", version: "2.1.303", billing: "subscription", plan: "pro" };

function tool(name: string) {
  return {
    name,
    label: name,
    description: `The ${name} tool.`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ content: [{ type: "text", text: `${name} done` }], details: {} })),
  };
}

async function setup(status: ClaudeCodeStatusView = READY) {
  const root = await mkdtemp(path.join(tmpdir(), "wisp-claude-code-factory-"));
  directories.push(root);
  const context = {
    conversationId: "c1",
    workspaceDirectory: path.join(root, "workspace"),
    sessionDirectory: root,
    configDirectory: root,
  } as ConversationAgentContext;
  await writeFile(path.join(root, "context-settings.json"), JSON.stringify({ policy: DEFAULT_CONTEXT_POLICY, memory: "Prefers short answers." }));
  const builder = {
    plan: vi.fn(async () => ({
      snapshot: { revision: "rev-7" },
      systemPrompt: () => "You are Lumen, a Wisp.",
      runSections: async (memory: string | undefined) => (memory ? [`## Memory\n${memory}`] : []),
    })),
    tools: vi.fn(async () => ({
      definitions: [tool("read"), tool("run_command")],
      registryNames: ["read", "run_command"],
      getAllowedTools: async () => ["read"],
    })),
  };
  const launches: ClaudeCodeQueryOptions[] = [];
  const query: ClaudeCodeQuery = ({ prompt, options }) => {
    launches.push(options);
    const outbox: unknown[] = [];
    let wake: (() => void) | undefined;
    // Like Claude Code, the process ends once its input has ended and the last turn is answered.
    let inputEnded = false;
    void (async () => {
      for await (const _message of prompt) {
        outbox.push({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: options.sessionId ?? options.resume,
        });
        wake?.();
      }
      inputEnded = true;
      wake?.();
    })();
    return {
      interrupt: async () => undefined,
      close: () => undefined,
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = outbox.shift();
          if (next) yield next;
          else if (inputEnded) return;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    };
  };
  const statusService = {
    current: () => status,
    refresh: async () => status,
    executable: () => "/usr/local/bin/claude",
  } as unknown as ClaudeCodeStatusService;
  const factory = new ClaudeCodeSessionFactory({
    builder: builder as never,
    status: statusService,
    query,
    environment: { HOME: "/home/person", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret" },
  });
  return { factory, context, launches, root, builder };
}

describe("ClaudeCodeSessionFactory", () => {
  it("refuses to start while Claude Code cannot run", async () => {
    const { factory, context } = await setup({ state: "missing" });

    expect(() => factory.resolveModel({ providerId: "claude-code", modelId: "sonnet" })).toThrow(
      "Claude Code is not installed on the server's computer.",
    );
    await expect(factory.create(context, { providerId: "claude-code", modelId: "sonnet" })).rejects.toMatchObject({
      code: "configuration_required",
    });
  });

  it("runs the person's claude with the Wisp's prompt, memory, and only its granted tools", async () => {
    const { factory, context, launches } = await setup();
    const session = await factory.create(context, {
      providerId: "claude-code",
      modelId: "opus",
      thinkingLevel: "high",
    });
    expect(session.toolRevision).toBe("rev-7");
    expect(session.getActiveToolNames()).toEqual(["read"]);

    await session.prompt("Hello");

    const options = launches[0]!;
    expect(options).toMatchObject({
      cwd: context.workspaceDirectory,
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      model: "opus",
      effort: "high",
      systemPrompt: { append: "You are Lumen, a Wisp.\n\n## Memory\nPrefers short answers." },
    });
    expect(options.env).toEqual({ HOME: "/home/person", PATH: "/usr/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (options.mcpServers.wisp!.instance as McpServer).connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["read"]);
    await client.close();
    await expect(options.canUseTool("WebFetch", {}, { signal: new AbortController().signal })).resolves.toMatchObject({
      behavior: "deny",
    });
    session.dispose();
  });

  it("saves a new session once it answered, and resumes it later", async () => {
    const { factory, context, launches, root } = await setup();
    const first = await factory.create(context, { providerId: "claude-code", modelId: "sonnet" });
    await expect(readFile(path.join(root, "claude-code-session.json"), "utf8")).rejects.toThrow();

    await first.prompt("Hello");
    first.dispose();
    const saved = JSON.parse(await readFile(path.join(root, "claude-code-session.json"), "utf8")) as {
      sessionId: string;
    };
    expect(saved.sessionId).toBe(launches[0]!.sessionId);

    const second = await factory.create(context, { providerId: "claude-code", modelId: "sonnet" });
    await second.prompt("Again");
    second.dispose();
    expect(launches[1]).toMatchObject({ resume: saved.sessionId });
    expect(launches[1]!.sessionId).toBeUndefined();
  });

  it("runs a job with the job's plan and tools in a process that keeps no session", async () => {
    const { factory, context, launches, root, builder } = await setup();
    const job = { runId: "run-1", runDirectory: path.join(root, "jobs"), tools: ["read"], skills: [], runTools: [] };

    const run = await factory.createJobSession(context, { providerId: "claude-code", modelId: "haiku" }, job);
    expect(launches).toHaveLength(0);
    await run.prompt("Report.", new AbortController().signal);
    run.dispose();

    expect(builder.plan).toHaveBeenCalledWith(context, job);
    expect(builder.tools).toHaveBeenCalledWith(context, expect.anything(), expect.objectContaining({ job }));
    expect(launches[0]).toMatchObject({ model: "haiku", persistSession: false });
    expect(launches[0]!.sessionId).toBeUndefined();
    await expect(readFile(path.join(root, "claude-code-session.json"), "utf8")).rejects.toThrow();
  });
});
