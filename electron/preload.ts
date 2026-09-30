import { contextBridge, ipcRenderer } from "electron";

import type { SequencedConversationAgentEvent, WispApi } from "../shared/contracts.js";

// Sandboxed preload scripts cannot require application modules at runtime.
// Keep this allowlist local and let the shared WispApi type enforce its shape.
const WISP_IPC_CHANNELS = {
  startConversation: "wisp:agent:start",
  sendMessage: "wisp:agent:send",
  abortConversation: "wisp:agent:abort",
  applyModel: "wisp:agent:apply-model",
  getConversationModel: "wisp:agent:get-model",
  manageContext: "wisp:agent:context",
  disposeConversation: "wisp:agent:dispose",
  agentEvent: "wisp:agent:event",
  getAiSettings: "wisp:settings:ai:get",
  getPluginSettings: "wisp:plugins:get",
  savePluginSettings: "wisp:plugins:save",
  removePlugin: "wisp:plugins:remove",
  testPluginConnection: "wisp:plugins:test",
  getWispPluginAccess: "wisp:plugins:access:get",
  saveWispPluginAccess: "wisp:plugins:access:save",
  getMcpSettings: "wisp:mcp:get",
  saveMcpServer: "wisp:mcp:save",
  removeMcpServer: "wisp:mcp:remove",
  testMcpConnection: "wisp:mcp:test",
  refreshMcpTools: "wisp:mcp:refresh",
  startMcpSignIn: "wisp:mcp:sign-in",
  mcpSettingsChanged: "wisp:mcp:changed",
  getWispMcpAccess: "wisp:mcp:access:get",
  saveWispMcpAccess: "wisp:mcp:access:save",
  saveAiSettings: "wisp:settings:ai:save",
  removeProviderCredential: "wisp:settings:ai:remove-credential",
  getConversationState: "wisp:conversations:get",
  initializeConversations: "wisp:conversations:initialize",
  createConversation: "wisp:conversations:create",
  updateConversation: "wisp:conversations:update",
  deleteConversation: "wisp:conversations:delete",
  appendConversationMessage: "wisp:conversations:append-message",
  answerConversationPrompt: "wisp:conversations:answer-prompt",
  markConversationRead: "wisp:conversations:mark-read",
  conversationChanged: "wisp:conversations:changed",
  getUsageReport: "wisp:usage:get",
  getToolPolicy: "wisp:tool-policy:get",
  saveToolPolicy: "wisp:tool-policy:save",
  resolveToolApproval: "wisp:tool-policy:resolve-approval",
  getSessionReport: "wisp:conversations:get-session-report",
  getUpdateState: "wisp:update:get-state",
  checkForUpdates: "wisp:update:check",
  downloadUpdate: "wisp:update:download",
  installUpdate: "wisp:update:install",
  openReleasesPage: "wisp:update:open-releases",
  updateState: "wisp:update:state",
} as const;

const wispApi: WispApi = {
  getPluginSettings: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getPluginSettings),
  savePluginSettings: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.savePluginSettings, request),
  removePlugin: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.removePlugin, request),
  testPluginConnection: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.testPluginConnection, request),
  getWispPluginAccess: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getWispPluginAccess, request),
  saveWispPluginAccess: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveWispPluginAccess, request),
  getMcpSettings: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getMcpSettings),
  saveMcpServer: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveMcpServer, request),
  removeMcpServer: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.removeMcpServer, request),
  testMcpConnection: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.testMcpConnection, request),
  refreshMcpTools: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.refreshMcpTools, request),
  startMcpSignIn: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.startMcpSignIn, request),
  getWispMcpAccess: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getWispMcpAccess, request),
  saveWispMcpAccess: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveWispMcpAccess, request),
  subscribeToMcpSettings: (listener) => {
    const handleSettings = (_event: Electron.IpcRendererEvent, view: Parameters<typeof listener>[0]): void =>
      listener(view);
    ipcRenderer.on(WISP_IPC_CHANNELS.mcpSettingsChanged, handleSettings);
    return () => ipcRenderer.removeListener(WISP_IPC_CHANNELS.mcpSettingsChanged, handleSettings);
  },
  manageContext: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.manageContext, request),
  startConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.startConversation, request),
  sendMessage: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.sendMessage, request),
  abortConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.abortConversation, request),
  getConversationModel: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getConversationModel, request),
  applyModel: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.applyModel, request),
  disposeConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.disposeConversation, request),
  subscribeToAgentEvents: (listener) => {
    const handleEvent = (_event: Electron.IpcRendererEvent, agentEvent: SequencedConversationAgentEvent): void => {
      listener(agentEvent);
    };
    ipcRenderer.on(WISP_IPC_CHANNELS.agentEvent, handleEvent);
    return () => ipcRenderer.removeListener(WISP_IPC_CHANNELS.agentEvent, handleEvent);
  },
  getAiSettings: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getAiSettings),
  saveAiSettings: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveAiSettings, request),
  removeProviderCredential: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.removeProviderCredential, request),
  getConversationState: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getConversationState),
  initializeConversations: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.initializeConversations, request),
  createConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.createConversation, request),
  updateConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.updateConversation, request),
  deleteConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.deleteConversation, request),
  appendConversationMessage: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.appendConversationMessage, request),
  answerConversationPrompt: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.answerConversationPrompt, request),
  markConversationRead: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.markConversationRead, request),
  subscribeToConversationChanges: (listener) => {
    const handleChat = (_event: Electron.IpcRendererEvent, chat: Parameters<typeof listener>[0]): void =>
      listener(chat);
    ipcRenderer.on(WISP_IPC_CHANNELS.conversationChanged, handleChat);
    return () => ipcRenderer.removeListener(WISP_IPC_CHANNELS.conversationChanged, handleChat);
  },
  getSessionReport: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getSessionReport, request),
  getUsageReport: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getUsageReport, request),
  getToolPolicy: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getToolPolicy),
  saveToolPolicy: (settings) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveToolPolicy, settings),
  resolveToolApproval: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.resolveToolApproval, request),
  getUpdateState: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.installUpdate),
  openReleasesPage: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.openReleasesPage),
  subscribeToUpdateState: (listener) => {
    const handleState = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void =>
      listener(state);
    ipcRenderer.on(WISP_IPC_CHANNELS.updateState, handleState);
    return () => ipcRenderer.removeListener(WISP_IPC_CHANNELS.updateState, handleState);
  },
};

contextBridge.exposeInMainWorld("wisp", Object.freeze(wispApi));
