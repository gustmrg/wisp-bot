import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { PluginService } from "../../backend/plugin-service.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerPluginHandlers(
  ipcMain: HandlerIpcMain,
  service: PluginService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
    [WISP_IPC_CHANNELS.getPluginSettings, () => service.getView()],
    [WISP_IPC_CHANNELS.savePluginSettings, (payload) => service.save(payload)],
    [WISP_IPC_CHANNELS.savePluginDefaults, (payload) => service.saveDefaults(payload)],
    [WISP_IPC_CHANNELS.removePlugin, (payload) => service.remove(payload)],
    [WISP_IPC_CHANNELS.testPluginConnection, (payload) => service.testConnection(payload)],
    [WISP_IPC_CHANNELS.getWispPluginAccess, (payload) => service.getAccess(payload)],
    [WISP_IPC_CHANNELS.saveWispPluginAccess, (payload) => service.saveAccess(payload)],
  ]);
}
