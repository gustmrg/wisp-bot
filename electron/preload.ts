import { contextBridge, ipcRenderer } from "electron";

import type { SequencedConversationAgentEvent, WispApi } from "../shared/contracts.js";

import type { BackendApi } from "../shared/backend-api.js";
import type { ConnectionApi } from "../shared/connections.js";
import type { ConversationStateView } from "../shared/conversations.js";

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
  getUsageReport: "wisp:usage:get",
  getToolPolicy: "wisp:tool-policy:get",
  saveToolPolicy: "wisp:tool-policy:save",
  resolveToolApproval: "wisp:tool-policy:resolve-approval",
  getSessionReport: "wisp:conversations:get-session-report",
  getUpdateState: "wisp:update:get-state",
  checkForUpdates: "wisp:update:check",
  downloadUpdate: "wisp:update:download",
  installUpdate: "wisp:update:install",
  updateState: "wisp:update:state",
} as const;

const wispApi: WispApi & BackendApi = {
  subscribeToConversationState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ConversationStateView): void => listener(state);
    ipcRenderer.on("wisp:conversations:state", handler);
    return () => ipcRenderer.removeListener("wisp:conversations:state", handler);
  },
  getConversationMessages: (request) => ipcRenderer.invoke("wisp:conversations:messages", request),
  refreshConnection: () => ipcRenderer.invoke("wisp:connections:refresh"),
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
  getSessionReport: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getSessionReport, request),
  getUsageReport: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.getUsageReport, request),
  getToolPolicy: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getToolPolicy),
  saveToolPolicy: (settings, expectedRevision) =>
    ipcRenderer.invoke(WISP_IPC_CHANNELS.saveToolPolicy, { ...settings, expectedRevision }),
  resolveToolApproval: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.resolveToolApproval, request),
  getUpdateState: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.installUpdate),
  subscribeToUpdateState: (listener) => {
    const handleState = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void =>
      listener(state);
    ipcRenderer.on(WISP_IPC_CHANNELS.updateState, handleState);
    return () => ipcRenderer.removeListener(WISP_IPC_CHANNELS.updateState, handleState);
  },
};

contextBridge.exposeInMainWorld("wisp", Object.freeze(wispApi));

const connections: ConnectionApi = {
  list: () => ipcRenderer.invoke("wisp:connections:list"),
  save: (profile) => ipcRenderer.invoke("wisp:connections:save", profile),
  delete: (request) => ipcRenderer.invoke("wisp:connections:delete", request),
  connect: (request) => ipcRenderer.invoke("wisp:connections:connect", request),
  disconnect: () => ipcRenderer.invoke("wisp:connections:disconnect"),
  getState: () => ipcRenderer.invoke("wisp:connections:get-state"),
  trustHost: (request) => ipcRenderer.invoke("wisp:connections:trust-host", request),
  openAuthentication: () => ipcRenderer.invoke("wisp:connections:open-authentication"),
  subscribeToState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => listener(state);
    ipcRenderer.on("wisp:connections:state", handler);
    return () => ipcRenderer.removeListener("wisp:connections:state", handler);
  },
};
contextBridge.exposeInMainWorld("wispConnections", Object.freeze(connections));
