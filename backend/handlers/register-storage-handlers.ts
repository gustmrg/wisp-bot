import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { StorageService } from "../storage-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import {
  parseStorageArchiveDeletionRequest,
  parseStorageCleanupConfirmation,
  parseStorageCleanupRequest,
  parseStorageDirectoryRequest,
  parseStorageSummaryRequest,
} from "../validators.js";

export function registerStorageHandlers(
  router: HandlerRouter,
  service: StorageService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getStorageSummary, (payload) => service.getSummary(parseStorageSummaryRequest(payload))],
    [WISP_IPC_CHANNELS.listStorageDirectory, (payload) => service.listDirectory(parseStorageDirectoryRequest(payload))],
    [WISP_IPC_CHANNELS.prepareStorageCleanup, (payload) => service.prepareCleanup(parseStorageCleanupRequest(payload))],
    [WISP_IPC_CHANNELS.cleanStorage, (payload) => service.cleanup(parseStorageCleanupConfirmation(payload))],
    [
      WISP_IPC_CHANNELS.deleteArchivedStorage,
      (payload) => service.deleteArchives(parseStorageArchiveDeletionRequest(payload)),
    ],
  ]);
}
