import { contextBridge, ipcRenderer } from "electron";

import type { ConversationAgentEvent, WispApi } from "../shared/contracts.js";

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
} as const;

const wispApi: WispApi = {
  startConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.startConversation, request),
  sendMessage: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.sendMessage, request),
  abortConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.abortConversation, request),
  applyModel: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.applyModel, request),
  disposeConversation: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.disposeConversation, request),
  subscribeToAgentEvents: (listener) => {
    const handleEvent = (_event: Electron.IpcRendererEvent, agentEvent: ConversationAgentEvent): void => {
      listener(agentEvent);
    };
    ipcRenderer.on(WISP_IPC_CHANNELS.agentEvent, handleEvent);
    return () => ipcRenderer.removeListener(WISP_IPC_CHANNELS.agentEvent, handleEvent);
  },
  getAiSettings: () => ipcRenderer.invoke(WISP_IPC_CHANNELS.getAiSettings),
  saveAiSettings: (request) => ipcRenderer.invoke(WISP_IPC_CHANNELS.saveAiSettings, request),
  removeProviderCredential: (request) => ipcRenderer.invoke(
    WISP_IPC_CHANNELS.removeProviderCredential,
    request,
  ),
};

contextBridge.exposeInMainWorld("wisp", Object.freeze(wispApi));
