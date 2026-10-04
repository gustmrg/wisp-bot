import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../electron/backend/conversation-agent.js";
import type { IntegrationToolSource, IntegrationToolSnapshot } from "../electron/backend/integration-tool-source.js";
import { snapshotRevision } from "../electron/backend/integration-tool-source.js";
import { mcpToolAlias } from "../shared/mcp.js";
import { registerDynamicToolMetadata, resetDynamicToolMetadata } from "../shared/tool-catalog.js";
import type { ModelRuntimeLike } from "../electron/backend/model-service.js";
import { SdkPiSessionFactory } from "../electron/backend/pi-conversation-agent.js";
import type { PluginToolSource } from "../electron/backend/plugin-types.js";
import { PluginService } from "../electron/backend/plugin-service.js";

function toToolSource(pluginTools: PluginToolSource): IntegrationToolSource {
  return {
    async getSnapshot(conversationId) {
      const definitions = pluginTools.getTools(conversationId);
      const activeNames = await pluginTools.getActiveToolNames(conversationId);
      return { definitions, metadata: [], activeNames, revision: snapshotRevision(activeNames) };
    },
  };
}

describe("Pi SDK integration", () => {
  it("keeps plugin tools isolated per Wisp across real SDK reloads", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-real-pi-plugins-"));
    const sessions: Array<{ dispose: () => void }> = [];
    try {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const runtime = await ModelRuntime.create({
        authPath: path.join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(directory, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const provider = runtime
        .getProviders()
        .find((candidate) => Boolean(candidate.auth.apiKey) && runtime.getModels(candidate.id).length > 0)!;
      const model = runtime.getModels(provider.id)[0]!;
      await runtime.setRuntimeApiKey(provider.id, "test-only-key");
      const grants: Record<string, string[]> = { researcher: ["web_search"], coordinator: ["linear_get_issue"] };
      const pluginTools: PluginToolSource = {
        getTools: () =>
          ["web_search", "linear_get_issue"].map((name) => ({
            name,
            label: name,
            description: "Test integration tool.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => ({ content: [{ type: "text", text: "test" }], details: {} }),
          })) as ReturnType<PluginToolSource["getTools"]>,
        getActiveToolNames: async (id) => grants[id] ?? [],
      };
      const factory = new SdkPiSessionFactory(runtime as ModelRuntimeLike, undefined, toToolSource(pluginTools));
      const create = async (id: string) => {
        const workspaceDirectory = path.join(directory, id, "workspace");
        const sessionDirectory = path.join(directory, id, "sessions");
        const configDirectory = path.join(directory, id, "config");
        await Promise.all(
          [workspaceDirectory, sessionDirectory, configDirectory].map((target) => mkdir(target, { recursive: true })),
        );
        const session = await factory.create(
          {
            conversationId: id,
            sessionId: id,
            name: id,
            label: "Test",
            description: "Test plugins.",
            workspaceDirectory,
            sessionDirectory,
            configDirectory,
          },
          { providerId: provider.id, modelId: model.id },
        );
        sessions.push(session);
        return session;
      };
      const researcher = await create("researcher");
      const coordinator = await create("coordinator");
      expect(researcher.getActiveToolNames()).toContain("web_search");
      expect(researcher.getActiveToolNames()).not.toContain("linear_get_issue");
      expect(coordinator.getActiveToolNames()).toContain("linear_get_issue");
      expect(coordinator.getActiveToolNames()).not.toContain("web_search");

      grants.researcher = [];
      await researcher.reload();
      expect(researcher.getActiveToolNames()).toHaveLength(9);
      expect(researcher.getActiveToolNames()).not.toContain("web_search");
      grants.researcher = ["linear_get_issue", "bash"];
      await researcher.reload();
      expect(researcher.getActiveToolNames()).toContain("linear_get_issue");
      expect(researcher.getActiveToolNames()).not.toContain("bash");
      expect(coordinator.getActiveToolNames()).toContain("linear_get_issue");
    } finally {
      sessions.forEach((session) => session.dispose());
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates and reopens one isolated persistent session without a provider request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-real-pi-sdk-"));
    try {
      const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
      const runtime = await ModelRuntime.create({
        authPath: path.join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(directory, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const provider = runtime
        .getProviders()
        .find((candidate) => Boolean(candidate.auth.apiKey) && runtime.getModels(candidate.id).length > 0);
      expect(provider).toBeDefined();
      const model = runtime.getModels(provider!.id)[0]!;
      await runtime.setRuntimeApiKey(provider!.id, "test-only-key");
      const workspaceDirectory = path.join(directory, "workspace");
      const sessionDirectory = path.join(directory, "sessions");
      const configDirectory = path.join(directory, "config");
      await Promise.all([
        mkdir(workspaceDirectory, { recursive: true }),
        mkdir(sessionDirectory, { recursive: true }),
        mkdir(configDirectory, { recursive: true }),
      ]);
      const saveIdentity = vi.fn(async () => undefined);
      const context: ConversationAgentContext = {
        conversationId: "integration",
        sessionId: "integration-app-session",
        name: "Integration Wisp",
        label: "Test",
        description: "Exercises the real Pi SDK without making a model request.",
        workspaceDirectory,
        sessionDirectory,
        configDirectory,
        piSessionId: null,
        piSessionFile: null,
        savePiSessionIdentity: saveIdentity,
      };
      const factory = new SdkPiSessionFactory(runtime as ModelRuntimeLike);
      const selection = { providerId: provider!.id, modelId: model.id };

      const first = await factory.create(context, selection);
      expect(first.getActiveToolNames().sort()).toEqual([
        "edit",
        "find",
        "grep",
        "ls",
        "read",
        "save_skill",
        "search_history",
        "use_skill",
        "write",
      ]);
      expect(first.sessionFile).toContain(sessionDirectory);
      const persistedIdentity = {
        piSessionId: first.sessionId,
        piSessionFile: first.sessionFile ?? null,
      };
      first.dispose();

      const reopened = await factory.create({ ...context, ...persistedIdentity }, selection);
      expect(reopened.sessionId).toBe(persistedIdentity.piSessionId);
      reopened.dispose();
      expect(saveIdentity).toHaveBeenCalledTimes(2);

      const pluginService = new PluginService({
        dataDirectory: path.join(directory, "plugins"),
        encryption: {
          isAvailable: () => true,
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        authorizationBroker: { authorize: async () => undefined },
        resolveWisp: () => context.sessionId,
      });
      await pluginService.load();
      await pluginService.save({ pluginId: "linear", enabled: true, apiKey: "test-only-plugin-key" });
      await pluginService.save({ pluginId: "web-search", enabled: true, apiKey: "test-only-brave-key" });
      await pluginService.save({ pluginId: "firecrawl", enabled: true, apiKey: "test-only-firecrawl-key" });
      await pluginService.saveAccess({
        ...pluginService.getAccess({ conversationId: context.conversationId }),
        grants: [
          { pluginId: "linear", access: "read" },
          { pluginId: "web-search", access: "read" },
          { pluginId: "firecrawl", access: "read" },
        ],
      });
      const pluginFactory = new SdkPiSessionFactory(runtime as ModelRuntimeLike, undefined, pluginService);
      const webSession = await pluginFactory.create({ ...context, ...persistedIdentity }, selection);
      try {
        expect(webSession.getActiveToolNames().filter((name) => name === "web_search")).toHaveLength(1);
        expect(webSession.getActiveToolNames()).toContain("web_read");
        expect(webSession.getActiveToolNames()).not.toContain("firecrawl_scrape");
        await webSession.reload();
        expect(webSession.getActiveToolNames()).toContain("web_read");
      } finally {
        webSession.dispose();
      }
      await writeFile(path.join(directory, "plugins", "plugin-credentials.enc.json"), "{corrupt");
      const fallback = await pluginFactory.create({ ...context, ...persistedIdentity }, selection);
      try {
        expect(fallback.getActiveToolNames().sort()).toEqual([
          "edit",
          "find",
          "grep",
          "ls",
          "read",
          "save_skill",
          "search_history",
          "use_skill",
          "write",
        ]);
        await fallback.reload();
        expect(fallback.getActiveToolNames()).toHaveLength(9);
      } finally {
        fallback.dispose();
        pluginService.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("reopens the exact session with dynamically discovered MCP tools after a snapshot change", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-real-pi-mcp-"));
  const sessions: Array<{ dispose: () => void }> = [];
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(directory, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = runtime
      .getProviders()
      .find((candidate) => Boolean(candidate.auth.apiKey) && runtime.getModels(candidate.id).length > 0)!;
    const model = runtime.getModels(provider.id)[0]!;
    await runtime.setRuntimeApiKey(provider.id, "test-only-key");

    const workspaceDirectory = path.join(directory, "workspace");
    const sessionDirectory = path.join(directory, "sessions");
    const configDirectory = path.join(directory, "config");
    await Promise.all(
      [workspaceDirectory, sessionDirectory, configDirectory].map((target) => mkdir(target, { recursive: true })),
    );
    // Seed a real Pi session file with history so the rebuild reopens it.
    // Pi defers file creation until the first assistant message, so a
    // hand-written header entry is the deterministic way to have on-disk state.
    const seededSessionId = "pi-session-rebuild";
    const seededSessionFile = path.join(sessionDirectory, "seeded.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: seededSessionId,
      timestamp: "2026-09-12T00:00:00.000Z",
      cwd: workspaceDirectory,
    };
    const userMessage = {
      type: "message",
      id: "seed-user",
      timestamp: "2026-09-12T00:00:01.000Z",
      message: { role: "user", content: "hello", attachments: [] },
    };
    await writeFile(
      seededSessionFile,
      `${JSON.stringify(header)}
${JSON.stringify(userMessage)}
`,
      "utf8",
    );

    const context: ConversationAgentContext = {
      conversationId: "mcp-wisp",
      sessionId: "mcp-app-session",
      name: "MCP Wisp",
      label: "Test",
      description: "Proves dynamic tool snapshots with the real SDK.",
      workspaceDirectory,
      sessionDirectory,
      configDirectory,
      piSessionId: seededSessionId,
      piSessionFile: seededSessionFile,
    };

    const serverId = "58ba17c5-4c75-4886-bf5a-d6efa5414b30";
    const alias = mcpToolAlias(serverId, "lookup_ticket");
    let snapshot: IntegrationToolSnapshot = {
      definitions: [],
      metadata: [],
      activeNames: [],
      revision: "rev-1",
    };
    const source: IntegrationToolSource = { getSnapshot: async () => snapshot };
    const factory = new SdkPiSessionFactory(runtime as ModelRuntimeLike, undefined, source);
    const selection = { providerId: provider.id, modelId: model.id };

    // Snapshot 1: no integrations; the seeded history must be adopted.
    const first = await factory.create(context, selection);
    sessions.push(first);
    expect(first.sessionId).toBe(seededSessionId);
    expect(first.sessionFile).toBe(seededSessionFile);
    expect(first.getActiveToolNames()).not.toContain(alias);
    expect(first.getActiveToolNames()).not.toContain("bash");

    // Snapshot 2: the server was granted and discovered one tool.
    resetDynamicToolMetadata();
    registerDynamicToolMetadata([
      { name: alias, label: "Lookup ticket", mcpServerId: serverId, sourceName: "lookup_ticket" },
    ]);
    snapshot = {
      definitions: [
        {
          name: alias,
          label: "Lookup ticket",
          description: "Look up a ticket in the connected tracker.",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          execute: async () => ({ content: [{ type: "text", text: "ticket" }], details: {} }),
        } as unknown as IntegrationToolSnapshot["definitions"][number],
      ],
      metadata: [
        {
          name: alias,
          label: "Lookup ticket",
          activityLabel: "Calling Lookup ticket…",
          category: "integration_call",
          mcpServerId: serverId,
          sourceName: "lookup_ticket",
        },
      ],
      activeNames: [alias],
      revision: "rev-2",
    };

    // Rebuild: same factory path the agent uses at the idle boundary.
    const rebuilt = await factory.create(context, selection);
    sessions.push(rebuilt);
    expect(rebuilt.sessionId).toBe(first.sessionId);
    expect(rebuilt.sessionFile).toBe(first.sessionFile);
    expect(rebuilt.getActiveToolNames()).toContain(alias);
    expect(rebuilt.getActiveToolNames()).toContain("read");
    expect(rebuilt.getActiveToolNames()).not.toContain("bash");
    expect(rebuilt.toolRevision).toBe("rev-2");

    // Safe tool identity is persisted with the session history so reports keep
    // identifying the tool after the server is removed.
    const sessionFileContent = await readFile(first.sessionFile!, "utf8");
    expect(sessionFileContent).toContain("wisp:mcp-tools");
    expect(sessionFileContent).toContain(alias);

    // Reopening with nothing new does not grow the session history.
    sessions.push(await factory.create(context, selection));
    const reopenedContent = await readFile(first.sessionFile!, "utf8");
    expect(reopenedContent.match(/"customType":"wisp:runtime"/g)).toHaveLength(1);
    expect(reopenedContent.match(/"customType":"wisp:mcp-tools"/g)).toHaveLength(1);
  } finally {
    sessions.forEach((session) => session.dispose());
    resetDynamicToolMetadata();
    await rm(directory, { recursive: true, force: true });
  }
});
