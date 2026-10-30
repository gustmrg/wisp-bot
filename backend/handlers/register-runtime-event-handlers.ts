import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import { WispBackendError } from "../backend-error.js";
import type { RuntimeEventLog } from "../runtime-event-log.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseRuntimeEventLogRequest, parseRuntimeEventRecordingRequest } from "../validators.js";

/**
 * The runtime events view (SWE-215). Only a running conversation can be
 * recorded; a conversation that is gone has its events forgotten.
 */
export function registerRuntimeEventHandlers(
  router: HandlerRouter,
  log: RuntimeEventLog,
  isRunning: (conversationId: string) => boolean,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const requireRunning = (conversationId: string): void => {
    if (isRunning(conversationId)) return;
    log.forget(conversationId);
    throw new WispBackendError("not_found", "The conversation was not found.");
  };
  return registerGuardedHandlers(router, authorizeSender, [
    [
      WISP_IPC_CHANNELS.getRuntimeEvents,
      (payload) => {
        const { conversationId, after } = parseRuntimeEventLogRequest(payload);
        requireRunning(conversationId);
        return log.read(conversationId, after);
      },
    ],
    [
      WISP_IPC_CHANNELS.setRuntimeEventRecording,
      (payload) => {
        const { conversationId, recording } = parseRuntimeEventRecordingRequest(payload);
        requireRunning(conversationId);
        return log.setRecording(conversationId, recording);
      },
    ],
  ]);
}
