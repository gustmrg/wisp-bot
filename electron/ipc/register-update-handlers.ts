import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { UpdateService } from "../backend/update-service.js";
import {
  registerGuardedHandlers,
  type HandlerRouter,
  type SenderAuthorizer,
} from "../../backend/handlers/guarded-handlers.js";

export function registerUpdateHandlers(
  router: HandlerRouter,
  service: UpdateService,
  authorizeSender: SenderAuthorizer,
  openReleasesPage: () => Promise<void>,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getUpdateState, () => service.getState()],
    [WISP_IPC_CHANNELS.checkForUpdates, () => service.check()],
    [WISP_IPC_CHANNELS.downloadUpdate, () => service.download()],
    [
      WISP_IPC_CHANNELS.installUpdate,
      () => {
        service.install();
        return {};
      },
    ],
    [
      WISP_IPC_CHANNELS.openReleasesPage,
      async () => {
        await openReleasesPage();
        return {};
      },
    ],
  ]);
}
