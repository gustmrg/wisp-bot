import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { TranscriptionService } from "../transcription-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseSaveVoiceCredentialRequest, parseTranscribeAudioRequest } from "../validators.js";

export function registerVoiceHandlers(
  router: HandlerRouter,
  service: TranscriptionService,
  authorizeSender: SenderAuthorizer,
  onCredentialChange?: () => Promise<void>,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getVoiceSettings, () => service.getView()],
    [
      WISP_IPC_CHANNELS.saveVoiceCredential,
      async (payload) => {
        const view = await service.saveCredential(parseSaveVoiceCredentialRequest(payload));
        await onCredentialChange?.();
        return view;
      },
    ],
    [WISP_IPC_CHANNELS.transcribeAudio, (payload) => service.transcribe(parseTranscribeAudioRequest(payload))],
  ]);
}
