import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { SessionReportService } from "../session-report-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseConversationRequest, parseUsageReportRequest } from "../validators.js";

export function registerSessionReportHandlers(
  router: HandlerRouter,
  service: SessionReportService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [
      WISP_IPC_CHANNELS.getSessionReport,
      (payload) => service.getSessionReport(parseConversationRequest(payload).conversationId),
    ],
    [WISP_IPC_CHANNELS.getUsageReport, (payload) => service.getUsageReport(parseUsageReportRequest(payload))],
  ]);
}
