import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { ExecutionService } from "../execution-service.js";
import { parseConversationRequest, parseSaveWispExecutionRequest } from "../validators.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerExecutionHandlers(
  router: HandlerRouter,
  service: ExecutionService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [
      WISP_IPC_CHANNELS.getWispExecution,
      (payload) => service.getView(parseConversationRequest(payload).conversationId),
    ],
    [WISP_IPC_CHANNELS.saveWispExecution, (payload) => service.save(parseSaveWispExecutionRequest(payload))],
  ]);
}
