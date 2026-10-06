import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { LaunchAtLoginService } from "../backend/launch-at-login-service.js";
import { WispBackendError } from "../../backend/backend-error.js";
import {
  registerGuardedHandlers,
  type HandlerRouter,
  type SenderAuthorizer,
} from "../../backend/handlers/guarded-handlers.js";

export function registerLaunchAtLoginHandlers(
  router: HandlerRouter,
  service: LaunchAtLoginService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getLaunchAtLoginState, () => service.getState()],
    [
      WISP_IPC_CHANNELS.setLaunchAtLogin,
      (enabled) => {
        if (typeof enabled !== "boolean")
          throw new WispBackendError("invalid_request", "Launch at login must be a boolean.");
        return service.setEnabled(enabled);
      },
    ],
  ]);
}
