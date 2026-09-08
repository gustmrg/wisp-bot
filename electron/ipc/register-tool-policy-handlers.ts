import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS, type BackendResult, type EmptyResult } from "../../shared/contracts.js";
import type { ToolPolicySettings } from "../../shared/tool-policy.js";
import { sanitizeBackendError, WispBackendError } from "../../backend/backend-error.js";
import type { ToolAuthorizationBroker } from "../../backend/tool-authorization-broker.js";
import type { SenderAuthorizer } from "./register-handlers.js";
import { parseResolveToolApprovalRequest } from "../../shared/validators.js";

type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
const unauthorized = (): WispBackendError => new WispBackendError("invalid_request", "The backend request is invalid.");

function failure(error: unknown): { ok: false; error: ReturnType<typeof sanitizeBackendError> } {
  return { ok: false, error: sanitizeBackendError(error) };
}

export function registerToolPolicyHandlers(
  ipcMain: HandlerIpcMain,
  broker: ToolAuthorizationBroker,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  ipcMain.handle(WISP_IPC_CHANNELS.getToolPolicy, (event: IpcMainInvokeEvent): BackendResult<ToolPolicySettings> => {
    if (!authorizeSender(event)) return failure(unauthorized());
    return { ok: true, value: broker.getPolicy() };
  });
  ipcMain.handle(
    WISP_IPC_CHANNELS.saveToolPolicy,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<BackendResult<ToolPolicySettings>> => {
      if (!authorizeSender(event)) return failure(unauthorized());
      try {
        return { ok: true, value: await broker.savePolicy(payload) };
      } catch (error) {
        return failure(error);
      }
    },
  );
  ipcMain.handle(
    WISP_IPC_CHANNELS.resolveToolApproval,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<EmptyResult> => {
      if (!authorizeSender(event)) return failure(unauthorized());
      try {
        await broker.resolve(parseResolveToolApprovalRequest(payload), event.sender.id);
        return { ok: true, value: {} };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return {
    dispose: () => {
      ipcMain.removeHandler(WISP_IPC_CHANNELS.getToolPolicy);
      ipcMain.removeHandler(WISP_IPC_CHANNELS.saveToolPolicy);
      ipcMain.removeHandler(WISP_IPC_CHANNELS.resolveToolApproval);
    },
  };
}
