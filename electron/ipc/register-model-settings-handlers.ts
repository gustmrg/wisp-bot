import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  WISP_IPC_CHANNELS,
  type AiSettingsView,
  type BackendResult,
} from "../../shared/contracts.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { ModelService } from "../backend/model-service.js";
import type { SenderAuthorizer } from "./register-handlers.js";
import {
  parseRemoveProviderCredentialRequest,
  parseSaveAiSettingsRequest,
} from "./validators.js";

type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;

async function toResult(operation: () => Promise<AiSettingsView>): Promise<BackendResult<AiSettingsView>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: sanitizeBackendError(error) };
  }
}

export function registerModelSettingsHandlers(
  ipcMain: HandlerIpcMain,
  modelService: ModelService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const registrations: ReadonlyArray<readonly [string, (payload: unknown) => Promise<BackendResult<AiSettingsView>>]> = [
    [WISP_IPC_CHANNELS.getAiSettings, () => toResult(() => modelService.getView())],
    [WISP_IPC_CHANNELS.saveAiSettings, (payload) => toResult(() => modelService.save(parseSaveAiSettingsRequest(payload)))],
    [WISP_IPC_CHANNELS.removeProviderCredential, (payload) => toResult(() => {
      const { providerId } = parseRemoveProviderCredentialRequest(payload);
      return modelService.removeCredential(providerId);
    })],
  ];

  for (const [channel, handler] of registrations) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!authorizeSender(event)) {
        return Promise.resolve<BackendResult<AiSettingsView>>({
          ok: false,
          error: {
            code: "invalid_request",
            message: "The backend request is invalid.",
            retryable: false,
          },
        });
      }
      return handler(payload);
    });
  }

  return {
    dispose: () => {
      for (const [channel] of registrations) ipcMain.removeHandler(channel);
    },
  };
}
