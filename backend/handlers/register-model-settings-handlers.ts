import { WISP_IPC_CHANNELS, type ModelSelection } from "../../shared/contracts.js";
import type { ModelService } from "../model-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseRemoveProviderCredentialRequest, parseSaveAiSettingsRequest } from "../validators.js";

export function registerModelSettingsHandlers(
  router: HandlerRouter,
  modelService: ModelService,
  authorizeSender: SenderAuthorizer,
  onSelectionChange?: (selection: ModelSelection | null) => Promise<void>,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
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
