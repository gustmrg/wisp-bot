import { WISP_IPC_CHANNELS, type ModelSelection } from "../../shared/contracts.js";
import type { ModelService } from "../model-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import {
  parseFinishProviderSignInRequest,
  parseLoadCustomEndpointModelsRequest,
  parseRemoveCustomEndpointRequest,
  parseSaveCustomEndpointRequest,
  parseProviderSignInRequest,
  parseRemoveProviderCredentialRequest,
  parseSaveAiSettingsRequest,
  parseSaveAuxiliaryModelRequest,
  parseSaveFallbackModelRequest,
} from "../validators.js";

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
      WISP_IPC_CHANNELS.saveAuxiliaryModel,
      (payload) => {
        const { task, selection } = parseSaveAuxiliaryModelRequest(payload);
        return modelService.saveAuxiliary(task, selection);
      },
    ],
    [
      WISP_IPC_CHANNELS.saveFallbackModel,
      (payload) => modelService.saveFallback(parseSaveFallbackModelRequest(payload).selection),
    ],
    [
      WISP_IPC_CHANNELS.removeProviderCredential,
      async (payload) => {
        const view = await modelService.removeCredential(parseRemoveProviderCredentialRequest(payload).providerId);
        await onSelectionChange?.(view.selection);
        return view;
      },
    ],
    [
      WISP_IPC_CHANNELS.startProviderSignIn,
      (payload) => modelService.startSignIn(parseProviderSignInRequest(payload).providerId),
    ],
    [
      WISP_IPC_CHANNELS.cancelProviderSignIn,
      (payload) => modelService.cancelSignIn(parseProviderSignInRequest(payload).providerId),
    ],
    [
      WISP_IPC_CHANNELS.finishProviderSignIn,
      (payload) => {
        const { providerId, redirectUrl } = parseFinishProviderSignInRequest(payload);
        return modelService.finishSignIn(providerId, redirectUrl);
      },
    ],
    [
      WISP_IPC_CHANNELS.saveCustomEndpoint,
      async (payload) => {
        // Changing an endpoint's models can leave the global model without one.
        const view = await modelService.saveCustomEndpoint(parseSaveCustomEndpointRequest(payload));
        await onSelectionChange?.(view.selection);
        return view;
      },
    ],
    [
      WISP_IPC_CHANNELS.removeCustomEndpoint,
      async (payload) => {
        const view = await modelService.removeCustomEndpoint(parseRemoveCustomEndpointRequest(payload).id);
        await onSelectionChange?.(view.selection);
        return view;
      },
    ],
    [
      WISP_IPC_CHANNELS.loadCustomEndpointModels,
      (payload) => modelService.loadCustomEndpointModels(parseLoadCustomEndpointModelsRequest(payload)),
    ],
    [WISP_IPC_CHANNELS.detectLocalEndpoints, () => modelService.detectLocalEndpoints()],
  ]);
}
