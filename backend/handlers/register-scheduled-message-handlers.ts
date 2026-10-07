import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { MessageScheduler } from "../message-scheduler.js";
import {
  parseScheduledMessageRequest,
  parseScheduleMessageRequest,
  parseUpdateScheduledMessageRequest,
} from "../validators.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerScheduledMessageHandlers(
  router: HandlerRouter,
  scheduler: MessageScheduler,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getScheduledMessages, () => scheduler.getView()],
    [WISP_IPC_CHANNELS.scheduleMessage, (payload) => scheduler.schedule(parseScheduleMessageRequest(payload))],
    [
      WISP_IPC_CHANNELS.updateScheduledMessage,
      (payload) => scheduler.update(parseUpdateScheduledMessageRequest(payload)),
    ],
    [
      WISP_IPC_CHANNELS.cancelScheduledMessage,
      (payload) => scheduler.cancel(parseScheduledMessageRequest(payload).scheduledMessageId),
    ],
    [
      WISP_IPC_CHANNELS.sendScheduledMessageNow,
      (payload) => scheduler.sendNow(parseScheduledMessageRequest(payload).scheduledMessageId),
    ],
  ]);
}
