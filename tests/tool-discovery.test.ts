import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../backend/conversation-agent.js";
import type { IntegrationToolSnapshot, SnapshotToolMetadata } from "../backend/integration-tool-source.js";
import type { ModelRuntimeLike } from "../backend/model-service.js";
import { SdkPiSessionFactory } from "../backend/pi-session-factory.js";
import {
  declaredTools,
  deferDefinition,
  deferIntegrationTools,
  deferredToolsSection,
  MAX_DECLARED_INTEGRATION_TOOLS,
  TOOL_SEARCH_TOOL,
} from "../backend/tool-discovery.js";
import { BlockMutationAuthorizer, TOOLS_NEVER_IN_JOB_RUNS, WispSessionBuilder } from "../backend/wisp-session-plan.js";
import { mcpToolAlias } from "../shared/mcp.js";
import { BUILTIN_TOOL_NAMES, resetDynamicToolMetadata } from "../shared/tool-catalog.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  resetDynamicToolMetadata();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const SERVER = "linear-server";

function metadata(name: string, group?: string): SnapshotToolMetadata {
  return {
    name,
    label: name,
    activityLabel: `Using ${name}…`,
    category: "integration_call",
    ...(group ? { group, mcpServerId: SERVER, sourceName: name } : {}),
  };
}

/** An MCP server named Linear with `count` tools, the first of which creates an issue. */
function linearServer(count: number, onCreate: (params: unknown) => void = () => undefined) {
  const tools = ["create_issue", ...Array.from({ length: count - 1 }, (_, index) => `list_things_${index}`)];
  const aliases = tools.map((tool) => mcpToolAlias(SERVER, tool));
  const definitions = tools.map(
    (tool, index) =>
      ({
        name: aliases[index]!,
        label: tool,
        description:
          tool === "create_issue" ? "Create a Linear issue with a title." : `List Linear things, set ${index}.`,
        parameters: { type: "object", properties: { title: { type: "string" } } },
        execute: async (_id: string, params: unknown) => {
          if (tool === "create_issue") onCreate(params);
          return { content: [{ type: "text", text: `${tool} done` }], details: {} };
        },
      }) as unknown as ToolDefinition,
  );
  return {
    aliases,
    definitions,
    metadata: tools.map((tool, index) => ({
      ...metadata(aliases[index]!, "Linear"),
      label: tool,
      sourceName: tool,
    })),
  };
}

function snapshot(
  server: ReturnType<typeof linearServer>,
  granted: ReadonlyArray<string> = server.aliases,
): IntegrationToolSnapshot {
  return {
    definitions: server.definitions,
    metadata: server.metadata,
    activeNames: [...granted],
    revision: granted.join(","),
  };
}

async function context(directory: string, id = "wisp"): Promise<ConversationAgentContext> {
  const workspaceDirectory = path.join(directory, id, "workspace");
  const sessionDirectory = path.join(directory, id, "sessions");
  const configDirectory = path.join(directory, id, "config");
  await Promise.all(
    [workspaceDirectory, sessionDirectory, configDirectory].map((target) => mkdir(target, { recursive: true })),
  );
  return {
    conversationId: id,
    sessionId: id,
    name: "Atlas",
    wispId: id,
    role: "Research",
    soul: "Finds things.",
    workspaceDirectory,
    sessionDirectory,
    configDirectory,
  };
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-tool-discovery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("deferIntegrationTools", () => {
  it("declares every tool of a Wisp with few integration tools", () => {
    const names = Array.from({ length: MAX_DECLARED_INTEGRATION_TOOLS }, (_, index) => `tool_${index}`);
    expect(
      deferIntegrationTools(
        names.map((name) => metadata(name, "Linear")),
        names,
      ).names.size,
    ).toBe(0);
  });

  it("defers the granted plugin and MCP tools above the limit, by integration", () => {
    const linear = Array.from({ length: 9 }, (_, index) => `linear_${index}`);
    const github = Array.from({ length: 5 }, (_, index) => `github_${index}`);
    const deferred = deferIntegrationTools(
      [
        ...linear.map((name) => metadata(name, "Linear")),
        ...github.map((name) => metadata(name, "GitHub")),
        metadata("web_search"),
        metadata("run_command"),
        metadata("ungranted", "Gmail"),
      ],
      [...linear, ...github, "web_search", "run_command"],
    );

    expect([...deferred.names].sort()).toEqual([...github, ...linear].sort());
    expect(deferred.groups).toEqual([
      { name: "GitHub", tools: 5 },
      { name: "Linear", tools: 9 },
    ]);
  });

  it("never defers the shared web tools, even with a group", () => {
    const names = Array.from({ length: 13 }, (_, index) => `tool_${index}`);
    const deferred = deferIntegrationTools(
      [...names.map((name) => metadata(name, "Linear")), metadata("web_search", "Brave")],
      [...names, "web_search"],
    );
    expect(deferred.names.has("web_search")).toBe(false);
  });
});

describe("tool discovery helpers", () => {
  it("tells the model what it can load and how", () => {
    const section = deferredToolsSection({ names: new Set(["a"]), groups: [{ name: "GitHub", tools: 42 }] }).join("\n");
    expect(section).toContain("GitHub (42 tools)");
    expect(section).toContain(`call ${TOOL_SEARCH_TOOL}`);
    expect(deferredToolsSection({ names: new Set(), groups: [] })).toEqual([]);
  });

  it("marks a definition deferred in its integration's namespace", () => {
    const definition = { name: "x", label: "x", description: "d", parameters: {} } as unknown as ToolDefinition;
    expect(deferDefinition(definition, "Linear")).toMatchObject({
      name: "x",
      exposure: "deferred",
      namespace: { name: "Linear" },
    });
  });

  it("declares a deferred tool only while it is loaded and still allowed", () => {
    expect(declaredTools(["read", "tool_search", "a", "b"], new Set(["a", "b"]), new Set(["a"]))).toEqual([
      "read",
      "tool_search",
      "a",
    ]);
    expect(declaredTools(["read", "tool_search", "b"], new Set(["a", "b"]), new Set(["a"]))).toEqual([
      "read",
      "tool_search",
    ]);
  });
});

describe("WispSessionBuilder with many integration tools", () => {
  const builder = (server: ReturnType<typeof linearServer>) =>
    new WispSessionBuilder({
      authorizationBroker: new BlockMutationAuthorizer(),
      toolSource: { getSnapshot: async () => snapshot(server) },
    });

  it("defers them for a runtime that loads tools, with tool_search and a prompt section", async () => {
    const server = linearServer(MAX_DECLARED_INTEGRATION_TOOLS + 1);
    const wisp = await context(await scratch());
    const plan = await builder(server).plan(wisp, undefined, { deferTools: true });
    const tools = await builder(server).tools(wisp, plan, { searchHistory: () => undefined });

    expect(plan.deferred.groups).toEqual([{ name: "Linear", tools: 13 }]);
    expect(plan.systemPrompt()).toContain("Linear (13 tools)");
    expect(tools.registryNames).toContain(TOOL_SEARCH_TOOL);
    expect(await tools.getAllowedTools()).toContain(TOOL_SEARCH_TOOL);
    expect([...tools.deferred].sort()).toEqual([...server.aliases].sort());
    const created = tools.definitions.find(({ name }) => name === server.aliases[0]);
    expect(created).toMatchObject({ exposure: "deferred", namespace: { name: "Linear" } });
  });

  it("defers nothing for Claude Code, which cannot load tools, nor in a job run", async () => {
    const server = linearServer(MAX_DECLARED_INTEGRATION_TOOLS + 1);
    const wisp = await context(await scratch());
    const claudeCode = await builder(server).plan(wisp);
    const job = await builder(server).plan(
      wisp,
      {
        runId: "run",
        runDirectory: wisp.sessionDirectory,
        tools: server.aliases,
        skills: [],
        runTools: [],
        memory: false,
      },
      { deferTools: true },
    );

    for (const plan of [claudeCode, job]) {
      expect(plan.deferred.names.size).toBe(0);
      expect(plan.systemPrompt()).not.toContain(TOOL_SEARCH_TOOL);
    }
    expect(
      (await builder(server).tools(wisp, claudeCode, { searchHistory: () => undefined })).registryNames,
    ).not.toContain(TOOL_SEARCH_TOOL);
    expect(BUILTIN_TOOL_NAMES).not.toContain(TOOL_SEARCH_TOOL);
    expect(TOOLS_NEVER_IN_JOB_RUNS.has(TOOL_SEARCH_TOOL)).toBe(true);
  });
});

describe("tool_search in a real Pi session", () => {
  it("declares a large integration's tools only once loaded, keeps them loaded, and drops a revoked one", async () => {
    const directory = await scratch();
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import("@earendil-works/pi-ai");
    const { getCurrentTools } = await import("@earendil-works/pi-ai/utils/transcript");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(directory, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ provider: "wisp-test-faux", models: [{ id: "scripted" }] });
    runtime.registerNativeProvider(faux.provider);

    const created = vi.fn();
    const server = linearServer(MAX_DECLARED_INTEGRATION_TOOLS + 3, created);
    const create = server.aliases[0]!;
    let granted = [...server.aliases];
    const declaredPerCall: string[][] = [];
    const respond = (message: ReturnType<typeof fauxAssistantMessage>) => (request: { messages: never }) => {
      declaredPerCall.push(getCurrentTools(request.messages).map(({ name }) => name));
      return message;
    };
    faux.setResponses([
      respond(
        fauxAssistantMessage(fauxToolCall(TOOL_SEARCH_TOOL, { query: "Linear create issue" }), {
          stopReason: "toolUse",
        }),
      ),
      respond(fauxAssistantMessage(fauxToolCall(create, { title: "Bug" }), { stopReason: "toolUse" })),
      respond(fauxAssistantMessage("Created.")),
      respond(fauxAssistantMessage("Anything else?")),
      respond(fauxAssistantMessage("Done.")),
    ] as never);

    const factory = new SdkPiSessionFactory(runtime as unknown as ModelRuntimeLike, undefined, {
      getSnapshot: async () => snapshot(server, granted),
    });
    const session = await factory.create(await context(directory), {
      providerId: "wisp-test-faux",
      modelId: "scripted",
    });
    cleanups.push(async () => session.dispose());

    expect(session.getActiveToolNames()).toContain(TOOL_SEARCH_TOOL);
    expect(session.getActiveToolNames()).not.toContain(create);

    await session.prompt("Open a bug in Linear.");
    expect(declaredPerCall[0]).toContain(TOOL_SEARCH_TOOL);
    expect(declaredPerCall[0]).not.toContain(create);
    expect(declaredPerCall[1]).toContain(create);
    expect(created).toHaveBeenCalledWith({ title: "Bug" });

    // The next message refreshes grants and keeps what tool_search loaded.
    await session.prompt("Thanks.");
    expect(declaredPerCall[3]).toContain(create);
    expect(session.getActiveToolNames().filter((name) => server.aliases.includes(name))).toEqual(
      expect.arrayContaining([create]),
    );

    // A revoked grant leaves even a loaded tool.
    granted = granted.filter((name) => name !== create);
    await session.prompt("Again.");
    expect(declaredPerCall[4]).not.toContain(create);
  });
});
