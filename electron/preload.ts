import { contextBridge, ipcRenderer } from "electron";

import type { SequencedConversationAgentEvent, WispApi } from "../shared/contracts.js";

// Sandboxed preload scripts cannot require application modules at runtime.
// Keep this allowlist local and let the shared WispApi type enforce its shape.
const WISP_IPC_CHANNELS = {
  startConversation: "wisp:agent:start",
  sendMessage: "wisp:agent:send",
  abortConversation: "wisp:agent:abort",
  applyModel: "wisp:agent:apply-model",
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

const wispApi: WispApi = {
  startConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.startConversation, request),
  sendMessage: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.sendMessage, request),
  abortConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.abortConversation, request),
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
  getToolPolicy: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getToolPolicy),
  saveToolPolicy: (settings) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveToolPolicy, settings),
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
