import { WISP_IPC_CHANNELS, type ModelSelection } from "../../shared/contracts.js";
import type { ModelService } from "../../backend/model-service.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseRemoveProviderCredentialRequest, parseSaveAiSettingsRequest } from "../../backend/validators.js";

export function registerModelSettingsHandlers(
  ipcMain: HandlerIpcMain,
  modelService: ModelService,
  authorizeSender: SenderAuthorizer,
  onSelectionChange?: (selection: ModelSelection | null) => Promise<void>,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
    [WISP_IPC_CHANNELS.getAiSettings, () => modelService.getView()],
    [
      WISP_IPC_CHANNELS.saveAiSettings,
      async (payload) => {
        const view = await modelService.save(parseSaveAiSettingsRequest(payload));
        await onSelectionChange?.(view.selection);
        return view;
      },
    ],
    [
      WISP_IPC_CHANNELS.removeProviderCredential,
      async (payload) => {
        const view = await modelService.removeCredential(parseRemoveProviderCredentialRequest(payload).providerId);
        await onSelectionChange?.(view.selection);
        return view;
      },
    ],
  ]);
}
