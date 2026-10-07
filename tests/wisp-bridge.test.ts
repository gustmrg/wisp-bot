import { describe, expect, it } from "vitest";

import type { ConnectionsView } from "../shared/connections.js";
import type { WispApi } from "../shared/contracts.js";
import { isWispBridgeAvailable } from "../src/lib/wisp-bridge.js";

const connections: ConnectionsView = {
  activeId: "local",
  profiles: [{ id: "local", kind: "local", name: "This computer", paired: true }],
  status: { profileId: "local", phase: "local", epoch: 1 },
  secureStorageAvailable: true,
};

function completeBridge(): WispApi {
  return {
    getLaunchAtLoginState: async () => ({ ok: true, value: { supported: false, enabled: false } }),
    setLaunchAtLogin: async () => ({ ok: true, value: { supported: false, enabled: false } }),
    getPluginSettings: async () => ({
      ok: true,
      value: { secureStorageAvailable: true, plugins: [], defaultProviders: { search: null, read: null } },
    }),
    savePluginSettings: async () => ({
      ok: true,
      value: { secureStorageAvailable: true, plugins: [], defaultProviders: { search: null, read: null } },
    }),
    savePluginDefaults: async () => ({
      ok: true,
      value: { secureStorageAvailable: true, plugins: [], defaultProviders: { search: null, read: null } },
    }),
    removePlugin: async () => ({
      ok: true,
      value: { secureStorageAvailable: true, plugins: [], defaultProviders: { search: null, read: null } },
    }),
    testPluginConnection: async () => ({ ok: true, value: { message: "Connected" } }),
    getWispPluginAccess: async ({ conversationId }) => ({
      ok: true,
      value: { conversationId, grants: [], revision: "test-revision", webProviders: { search: null, read: null } },
    }),
    saveWispPluginAccess: async (request) => ({
      ok: true,
      value: { ...request, webProviders: request.webProviders ?? { search: null, read: null } },
    }),
    getMcpSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    saveMcpServer: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    removeMcpServer: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    testMcpConnection: async () => ({ ok: true, value: { message: "Connected" } }),
    refreshMcpTools: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    startMcpSignIn: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    cancelMcpSignIn: async () => ({ ok: true, value: { secureStorageAvailable: true, servers: [] } }),
    getWispMcpAccess: async ({ conversationId }) => ({
      ok: true,
      value: { conversationId, grants: [], revision: "test-revision", webProviders: { search: null, read: null } },
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
    subscribeToConversationChanges: () => () => undefined,
    getConversationMessages: async () => ({ ok: true, value: { messages: [], olderCursor: null, newerCursor: null } }),
    searchMessages: async () => ({ ok: true, value: [] }),
    getScheduledMessages: async () => ({ ok: true, value: { messages: [] } }),
    scheduleMessage: async () => ({ ok: true, value: { messages: [] } }),
    updateScheduledMessage: async () => ({ ok: true, value: { messages: [] } }),
    cancelScheduledMessage: async () => ({ ok: true, value: { messages: [] } }),
    sendScheduledMessageNow: async () => ({ ok: true, value: { messages: [] } }),
    subscribeToScheduledMessages: () => () => undefined,
    getMessageQueue: async () => ({ ok: true, value: { messages: [] } }),
    queueMessage: async () => ({ ok: true, value: { messages: [] } }),
    updateQueuedMessage: async () => ({ ok: true, value: { messages: [] } }),
    cancelQueuedMessage: async () => ({ ok: true, value: { messages: [] } }),
    subscribeToMessageQueue: () => () => undefined,
    getUsageReport: async () => {
      throw new Error("Not implemented in test");
    },
    getSessionReport: async () => {
      throw new Error("not called");
    },
    getToolPolicy: async () => {
      throw new Error("not called");
    },
    getUserProfile: async () => ({
      ok: true as const,
      value: { preferredName: "", aboutYou: "", responsePreferences: "" },
    }),
    saveUserProfile: async (profile) => ({ ok: true as const, value: profile }),
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
    getWorkspace: async () => ({ ok: true, value: { usedBytes: 0, quotaBytes: 1024 } }),
    openWorkspaceFolder: async () => ({ ok: true, value: {} }),
    openSkillsFolder: async () => ({ ok: true, value: {} }),
    attachWorkspaceFiles: async () => ({
      ok: true,
      value: { files: [], workspace: { usedBytes: 0, quotaBytes: 1024 } },
    }),
    listSkills: async () => ({ ok: true, value: [] }),
    deleteSkill: async () => ({ ok: true, value: [] }),
    getVoiceSettings: async () => ({ ok: true, value: { secureStorageAvailable: true, providers: [] } }),
    saveVoiceCredential: async () => ({ ok: true, value: { secureStorageAvailable: true, providers: [] } }),
    transcribeAudio: async () => ({ ok: true, value: { text: "" } }),
    getConnections: async () => ({ ok: true, value: connections }),
    saveConnection: async () => ({ ok: true, value: connections }),
    removeConnection: async () => ({ ok: true, value: connections }),
    activateConnection: async () => ({ ok: true, value: connections }),
    retryConnection: async () => ({ ok: true, value: connections }),
    installServer: async () => ({ ok: true, value: connections }),
    cancelServerInstall: async () => ({ ok: true, value: connections }),
    subscribeToConnections: () => () => undefined,
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
