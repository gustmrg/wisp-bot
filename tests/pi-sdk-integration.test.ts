import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ConversationAgentContext } from "../electron/backend/conversation-agent.js";
import type { ModelRuntimeLike } from "../electron/backend/model-service.js";
import { SdkPiSessionFactory } from "../electron/backend/pi-conversation-agent.js";

describe("Pi SDK integration", () => {
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
      expect(first.getActiveToolNames().sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
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
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
