import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { MessageQueue } from "../message-queue.js";
import { parseQueuedMessageRequest, parseQueueMessageRequest, parseUpdateQueuedMessageRequest } from "../validators.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";

export function registerMessageQueueHandlers(
  router: HandlerRouter,
  queue: MessageQueue,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getMessageQueue, () => queue.getView()],
    [
      WISP_IPC_CHANNELS.queueMessage,
      (payload) => {
        const request = parseQueueMessageRequest(payload);
        return queue.enqueue(request.conversationId, request.text);
      },
    ],
    [
      WISP_IPC_CHANNELS.updateQueuedMessage,
      (payload) => {
        const request = parseUpdateQueuedMessageRequest(payload);
        return queue.update(request.queuedMessageId, request.text);
      },
    ],
    [
      WISP_IPC_CHANNELS.cancelQueuedMessage,
      (payload) => queue.cancel(parseQueuedMessageRequest(payload).queuedMessageId),
    ],
  ]);
}
