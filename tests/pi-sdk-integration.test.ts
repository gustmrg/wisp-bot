import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../electron/backend/conversation-agent.js";
import type { ModelRuntimeLike } from "../electron/backend/model-service.js";
import { SdkPiSessionFactory } from "../electron/backend/pi-conversation-agent.js";
import type { PluginToolSource } from "../electron/backend/plugin-types.js";
import { PluginService } from "../electron/backend/plugin-service.js";

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
      const factory = new SdkPiSessionFactory(runtime as ModelRuntimeLike, undefined, pluginTools);
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
      expect(researcher.getActiveToolNames()).toHaveLength(7);
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
        "search_history",
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
      await pluginService.saveAccess({
        ...pluginService.getAccess({ conversationId: context.conversationId }),
        grants: [{ pluginId: "linear", access: "read" }],
      });
      await writeFile(path.join(directory, "plugins", "plugin-credentials.enc.json"), "{corrupt");
      const pluginFactory = new SdkPiSessionFactory(runtime as ModelRuntimeLike, undefined, pluginService);
      const fallback = await pluginFactory.create({ ...context, ...persistedIdentity }, selection);
      try {
        expect(fallback.getActiveToolNames().sort()).toEqual([
          "edit",
          "find",
          "grep",
          "ls",
          "read",
          "search_history",
          "write",
        ]);
        await fallback.reload();
        expect(fallback.getActiveToolNames()).toHaveLength(7);
      } finally {
        fallback.dispose();
        pluginService.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
