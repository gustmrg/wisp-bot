import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { McpService } from "../backend/mcp-service.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { SenderAuthorizer } from "./register-handlers.js";

export function registerMcpHandlers(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  service: McpService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const handlers: ReadonlyArray<readonly [string, (payload: unknown) => unknown]> = [
    [WISP_IPC_CHANNELS.getMcpSettings, () => service.getView()],
    [WISP_IPC_CHANNELS.saveMcpServer, (payload) => service.save(payload)],
    [WISP_IPC_CHANNELS.removeMcpServer, (payload) => service.remove(payload)],
    [WISP_IPC_CHANNELS.testMcpConnection, (payload) => service.testConnection(payload)],
    [WISP_IPC_CHANNELS.refreshMcpTools, (payload) => service.refreshTools(payload)],
    [WISP_IPC_CHANNELS.startMcpSignIn, (payload) => service.startSignIn(payload)],
    [WISP_IPC_CHANNELS.cancelMcpSignIn, (payload) => service.cancelSignIn(payload)],
    [WISP_IPC_CHANNELS.getWispMcpAccess, (payload) => service.getAccess(payload)],
    [WISP_IPC_CHANNELS.saveWispMcpAccess, (payload) => service.saveAccess(payload)],
  ];
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown): Promise<BackendResult<unknown>> => {
      if (!authorizeSender(event))
        return {
          ok: false,
          error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
        };
      try {
        return { ok: true, value: await handler(payload) };
      } catch (error) {
        return { ok: false, error: sanitizeBackendError(error) };
      }
    });
  }
  return {
    dispose: () => {
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
    },
  };
}
