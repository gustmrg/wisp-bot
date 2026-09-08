import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS, type BackendResult, type UpdateState } from "../../shared/contracts.js";
import { sanitizeBackendError } from "../../backend/backend-error.js";
import type { UpdateService } from "../backend/update-service.js";
import type { SenderAuthorizer } from "./register-handlers.js";

type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
const emptyValue: Record<string, never> = {};

export function registerUpdateHandlers(
  ipcMain: HandlerIpcMain,
  service: UpdateService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const result = async <T>(operation: () => Promise<T> | T): Promise<BackendResult<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error: sanitizeBackendError(error) };
    }
  };
  const authorized = <T>(event: IpcMainInvokeEvent, operation: () => Promise<T> | T) =>
    authorizeSender(event)
      ? result(operation)
      : Promise.resolve({
          ok: false as const,
          error: { code: "invalid_request" as const, message: "The backend request is invalid.", retryable: false },
        });
  const registrations = [
    [
      WISP_IPC_CHANNELS.getUpdateState,
      (event: IpcMainInvokeEvent) => authorized<UpdateState>(event, () => service.getState()),
    ],
    [WISP_IPC_CHANNELS.checkForUpdates, (event: IpcMainInvokeEvent) => authorized(event, () => service.check())],
    [WISP_IPC_CHANNELS.downloadUpdate, (event: IpcMainInvokeEvent) => authorized(event, () => service.download())],
    [
      WISP_IPC_CHANNELS.installUpdate,
      (event: IpcMainInvokeEvent) =>
        authorized<Record<string, never>>(event, () => {
          service.install();
          return emptyValue;
        }),
    ],
  ] as const;
  for (const [channel, handler] of registrations) ipcMain.handle(channel, handler);
  return { dispose: () => registrations.forEach(([channel]) => ipcMain.removeHandler(channel)) };
}
