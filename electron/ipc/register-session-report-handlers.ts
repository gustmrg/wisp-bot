import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS, type BackendResult, type WispSessionReport } from "../../shared/contracts.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { SessionReportService } from "../backend/session-report-service.js";
import type { SenderAuthorizer } from "./register-handlers.js";
import { parseConversationRequest } from "./validators.js";

type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
type Result = BackendResult<WispSessionReport | null>;

export function registerSessionReportHandlers(
  ipcMain: HandlerIpcMain,
  service: SessionReportService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const registrations: ReadonlyArray<readonly [string, (payload: unknown) => Promise<Result>]> = [
    [
      WISP_IPC_CHANNELS.getSessionReport,
      async (payload) => {
        try {
          const { conversationId } = parseConversationRequest(payload);
          return { ok: true, value: await service.getSessionReport(conversationId) };
        } catch (error) {
          return { ok: false, error: sanitizeBackendError(error) };
        }
      },
    ],
  ];

  for (const [channel, handler] of registrations) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!authorizeSender(event)) {
        return Promise.resolve<Result>({
          ok: false,
          error: {
            code: "invalid_request",
            message: "The backend request is invalid.",
            retryable: false,
          },
        });
      }
      return handler(payload);
    });
  }

  return {
    dispose: () => {
      for (const [channel] of registrations) ipcMain.removeHandler(channel);
    },
  };
}
