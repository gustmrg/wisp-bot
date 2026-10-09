import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { ConversationService } from "../conversation-service.js";
import { registerGuardedHandlers, type HandlerRouter, type SenderAuthorizer } from "./guarded-handlers.js";
import {
  parseAnswerConversationPromptRequest,
  parseAppendConversationMessageRequest,
  parseCreateConversationRequest,
  parseCreateWispRequest,
  parseDeleteConversationRequest,
  parseDeleteWispRequest,
  parseInitializeConversationsRequest,
  parseMarkConversationReadRequest,
  parseMessagePageRequest,
  parseSearchMessagesRequest,
  parseSetUserTimeZoneRequest,
  parseUpdateConversationRequest,
  parseUpdateWispRequest,
} from "../validators.js";

export function registerConversationHandlers(
  router: HandlerRouter,
  service: ConversationService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(router, authorizeSender, [
    [WISP_IPC_CHANNELS.getUserProfile, () => service.getUserProfile()],
    [WISP_IPC_CHANNELS.saveUserProfile, (payload) => service.saveUserProfile(payload)],
    [
      WISP_IPC_CHANNELS.setUserTimeZone,
      (payload) => service.saveUserTimeZone(parseSetUserTimeZoneRequest(payload).timeZone),
    ],
    [WISP_IPC_CHANNELS.getConversationState, () => service.getState()],
    [
      WISP_IPC_CHANNELS.initializeConversations,
      (payload) => service.initialize(parseInitializeConversationsRequest(payload).chats),
    ],
    [
      WISP_IPC_CHANNELS.createWisp,
      (payload) => {
        const request = parseCreateWispRequest(payload);
        return service.createWisp(request.wisp, {
          notifyOnUpdatesEnabled: request.notifyOnUpdatesEnabled,
          model: request.model,
        });
      },
    ],
    [
      WISP_IPC_CHANNELS.updateWisp,
      (payload) => {
        const request = parseUpdateWispRequest(payload);
        return service.updateWisp(request.wispId, request.changes);
      },
    ],
    [WISP_IPC_CHANNELS.deleteWisp, (payload) => service.deleteWisp(parseDeleteWispRequest(payload).wispId)],
    [
      WISP_IPC_CHANNELS.createConversation,
      (payload) => service.create(parseCreateConversationRequest(payload).conversation),
    ],
    [
      WISP_IPC_CHANNELS.updateConversation,
      (payload) => {
        const request = parseUpdateConversationRequest(payload);
        return service.update(request.conversationId, request.changes);
      },
    ],
    [
      WISP_IPC_CHANNELS.deleteConversation,
      (payload) => service.delete(parseDeleteConversationRequest(payload).conversationId),
    ],
    [
      WISP_IPC_CHANNELS.appendConversationMessage,
      (payload) => {
        const request = parseAppendConversationMessageRequest(payload);
        return service.appendMessage(request.conversationId, request.message);
      },
    ],
    [
      WISP_IPC_CHANNELS.answerConversationPrompt,
      (payload) => {
        const request = parseAnswerConversationPromptRequest(payload);
        return service.answerPrompt(request.conversationId, request.messageId, request.answer);
      },
    ],
    [
      WISP_IPC_CHANNELS.markConversationRead,
      (payload) => service.markRead(parseMarkConversationReadRequest(payload).conversationId),
    ],
    [WISP_IPC_CHANNELS.getConversationMessages, (payload) => service.getMessagePage(parseMessagePageRequest(payload))],
    [WISP_IPC_CHANNELS.searchMessages, (payload) => service.searchMessages(parseSearchMessagesRequest(payload).query)],
  ]);
}
