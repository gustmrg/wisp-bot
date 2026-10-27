import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { WispSetupView } from "../../shared/execution.js";
import type { ExecutionService } from "../execution-service.js";
import { parseConversationRequest, parseSaveWispExecutionRequest } from "../validators.js";
import type { WorkspaceService } from "../workspace-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerExecutionHandlers(
  router: HandlerRouter,
  service: ExecutionService,
  workspace: Pick<WorkspaceService, "newWorkspaceRoom">,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [
      WISP_IPC_CHANNELS.getWispExecution,
      (payload) => service.getView(parseConversationRequest(payload).conversationId),
    ],
    [WISP_IPC_CHANNELS.saveWispExecution, (payload) => service.save(parseSaveWispExecutionRequest(payload))],
    [
      WISP_IPC_CHANNELS.getWispSetup,
      async (): Promise<WispSetupView> => {
        const [maxQuotaBytes, runtime] = await Promise.all([workspace.newWorkspaceRoom(), service.runtimeStatus()]);
        return { maxQuotaBytes, unlimitedWorkspaces: true, runtime };
      },
    ],
  ]);
}
