import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { PluginService } from "../backend/plugin-service.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { SenderAuthorizer } from "./register-handlers.js";

export function registerPluginHandlers(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  service: PluginService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const handlers: ReadonlyArray<readonly [string, (payload: unknown) => unknown]> = [
    [WISP_IPC_CHANNELS.getPluginSettings, () => service.getView()],
    [WISP_IPC_CHANNELS.savePluginSettings, (payload) => service.save(payload)],
    [WISP_IPC_CHANNELS.removePlugin, (payload) => service.remove(payload)],
    [WISP_IPC_CHANNELS.testPluginConnection, (payload) => service.testConnection(payload)],
    [WISP_IPC_CHANNELS.getWispPluginAccess, (payload) => service.getAccess(payload)],
    [WISP_IPC_CHANNELS.saveWispPluginAccess, (payload) => service.saveAccess(payload)],
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
