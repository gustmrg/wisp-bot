import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { McpService } from "../backend/mcp-service.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerMcpHandlers(
  ipcMain: HandlerIpcMain,
  service: McpService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
    [WISP_IPC_CHANNELS.getMcpSettings, () => service.getView()],
    [WISP_IPC_CHANNELS.saveMcpServer, (payload) => service.save(payload)],
    [WISP_IPC_CHANNELS.removeMcpServer, (payload) => service.remove(payload)],
    [WISP_IPC_CHANNELS.testMcpConnection, (payload) => service.testConnection(payload)],
    [WISP_IPC_CHANNELS.refreshMcpTools, (payload) => service.refreshTools(payload)],
    [WISP_IPC_CHANNELS.startMcpSignIn, (payload) => service.startSignIn(payload)],
    [WISP_IPC_CHANNELS.cancelMcpSignIn, (payload) => service.cancelSignIn(payload)],
    [WISP_IPC_CHANNELS.getWispMcpAccess, (payload) => service.getAccess(payload)],
    [WISP_IPC_CHANNELS.saveWispMcpAccess, (payload) => service.saveAccess(payload)],
  ]);
}
