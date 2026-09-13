import { describe, expect, it } from "vitest";

import type { WispApi } from "../shared/contracts.js";
import { isWispBridgeAvailable } from "../src/lib/wisp-bridge.js";

function completeBridge(): WispApi {
  return {
    getPluginSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, plugins: [] } }),
    savePluginSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, plugins: [] } }),
    removePlugin: async () => ({ ok: true, value: { secureStorageAvailable: true, plugins: [] } }),
    testPluginConnection: async () => ({ ok: true, value: { message: "Connected" } }),
    getWispPluginAccess: async ({ conversationId }) => ({
      ok: true,
      value: { conversationId, grants: [], revision: "test-revision" },
    }),
    saveWispPluginAccess: async (request) => ({ ok: true, value: request }),
    getMcpSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    saveMcpServer: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    removeMcpServer: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    testMcpConnection: async () => ({ ok: true, value: { message: "Connected" } }),
    refreshMcpTools: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    startMcpSignIn: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    getWispMcpAccess: async ({ conversationId }) => ({
      ok: true,
      value: { conversationId, grants: [], revision: "test-revision" },
    }),
    saveWispMcpAccess: async (request) => ({ ok: true, value: request }),
    subscribeToMcpSettings: () => () => undefined,
    startConversation: async () => ({ ok: true, value: {} }),
    sendMessage: async () => ({ ok: true, value: {} }),
    abortConversation: async () => ({ ok: true, value: {} }),
    manageContext: async () => ({
      ok: false as const,
      error: { code: "configuration_required" as const, message: "Configure a model", retryable: false },
    }),
    getConversationModel: async () => ({
      ok: true as const,
      value: {
        override: null,
        effective: null,
        applied: null,
        pending: null,
        status: "configuration_required" as const,
      },
    }),
    applyModel: async () => ({ ok: true, value: {} }),
    disposeConversation: async () => ({ ok: true, value: {} }),
    subscribeToAgentEvents: () => () => undefined,
    getAiSettings: async () => {
      throw new Error("not called");
    },
    saveAiSettings: async () => {
      throw new Error("not called");
    },
    removeProviderCredential: async () => {
      throw new Error("not called");
    },
    getConversationState: async () => {
      throw new Error("not called");
    },
    initializeConversations: async () => {
      throw new Error("not called");
    },
    createConversation: async () => {
      throw new Error("not called");
    },
    updateConversation: async () => {
      throw new Error("not called");
    },
    deleteConversation: async () => {
      throw new Error("not called");
    },
    appendConversationMessage: async () => {
      throw new Error("not called");
    },
    answerConversationPrompt: async () => {
      throw new Error("not called");
    },
    markConversationRead: async () => {
      throw new Error("not called");
    },
    getUsageReport: async () => {
      throw new Error("Not implemented in test");
    },
    getSessionReport: async () => {
      throw new Error("not called");
    },
    getToolPolicy: async () => {
      throw new Error("not called");
    },
    saveToolPolicy: async () => {
      throw new Error("not called");
    },
    resolveToolApproval: async () => ({ ok: true, value: {} }),
    getUpdateState: async () => ({ ok: true, value: { phase: "idle", currentVersion: "0.1.0" } }),
    checkForUpdates: async () => ({ ok: true, value: { phase: "up-to-date", currentVersion: "0.1.0" } }),
    downloadUpdate: async () => ({ ok: true, value: { phase: "downloaded", currentVersion: "0.1.0" } }),
    installUpdate: async () => ({ ok: true, value: {} }),
    openReleasesPage: async () => ({ ok: true, value: {} }),
    subscribeToUpdateState: () => () => undefined,
  };
}

describe("isWispBridgeAvailable", () => {
  it("rejects a missing or partial preload bridge", () => {
    expect(isWispBridgeAvailable(undefined)).toBe(false);
    expect(isWispBridgeAvailable({ subscribeToAgentEvents: () => undefined })).toBe(false);
  });

  it("accepts the complete preload contract", () => {
    expect(isWispBridgeAvailable(completeBridge())).toBe(true);
  });
});
