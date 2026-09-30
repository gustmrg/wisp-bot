import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { ConversationService } from "../backend/conversation-service.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";
import {
  parseAnswerConversationPromptRequest,
  parseAppendConversationMessageRequest,
  parseCreateConversationRequest,
  parseDeleteConversationRequest,
  parseInitializeConversationsRequest,
  parseMarkConversationReadRequest,
  parseMessagePageRequest,
  parseSearchMessagesRequest,
  parseUpdateConversationRequest,
} from "./validators.js";

export function registerConversationHandlers(
  ipcMain: HandlerIpcMain,
  service: ConversationService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
    [WISP_IPC_CHANNELS.getConversationState, () => service.getState()],
    [
      WISP_IPC_CHANNELS.initializeConversations,
      (payload) => service.initialize(parseInitializeConversationsRequest(payload).chats),
    ],
    [
      WISP_IPC_CHANNELS.createConversation,
      (payload) => {
        const request = parseCreateConversationRequest(payload);
        return service.create(request.conversation, request.model);
      },
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
