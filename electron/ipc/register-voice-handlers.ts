import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { TranscriptionService } from "../../backend/transcription-service.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseSaveVoiceCredentialRequest, parseTranscribeAudioRequest } from "../../backend/validators.js";

export function registerVoiceHandlers(
  ipcMain: HandlerIpcMain,
  service: TranscriptionService,
  authorizeSender: SenderAuthorizer,
  onCredentialChange?: () => Promise<void>,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
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
