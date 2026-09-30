import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { ToolAuthorizationBroker } from "../backend/tool-authorization-broker.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseResolveToolApprovalRequest } from "./validators.js";

export function registerToolPolicyHandlers(
  ipcMain: HandlerIpcMain,
  broker: ToolAuthorizationBroker,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
    [WISP_IPC_CHANNELS.getToolPolicy, () => broker.getPolicy()],
    [WISP_IPC_CHANNELS.saveToolPolicy, (payload) => broker.savePolicy(payload)],
    [
      WISP_IPC_CHANNELS.resolveToolApproval,
      async (payload, event) => {
        // Approvals are bound to the window they were shown in.
        await broker.resolve(parseResolveToolApprovalRequest(payload), event.sender.id);
        return {};
      },
    ],
  ]);
}
