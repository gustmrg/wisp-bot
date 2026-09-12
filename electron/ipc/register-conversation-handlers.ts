import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { ConversationStateView } from "../../shared/conversations.js";
import { sanitizeBackendError } from "../backend/backend-error.js";
import type { ConversationService } from "../backend/conversation-service.js";
import type { SenderAuthorizer } from "./register-handlers.js";
import {
  parseAnswerConversationPromptRequest,
  parseAppendConversationMessageRequest,
  parseCreateConversationRequest,
  parseDeleteConversationRequest,
  parseInitializeConversationsRequest,
  parseMarkConversationReadRequest,
  parseUpdateConversationRequest,
} from "./validators.js";

type HandlerIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
type Result = BackendResult<ConversationStateView>;

async function toResult(operation: () => Promise<ConversationStateView> | ConversationStateView): Promise<Result> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: sanitizeBackendError(error) };
  }
}

export function registerConversationHandlers(
  ipcMain: HandlerIpcMain,
  service: ConversationService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const registrations: ReadonlyArray<readonly [string, (payload: unknown) => Promise<Result>]> = [
    [WISP_IPC_CHANNELS.getConversationState, () => toResult(() => service.getState())],
    [
      WISP_IPC_CHANNELS.initializeConversations,
      (payload) =>
        toResult(() => {
          const request = parseInitializeConversationsRequest(payload);
          return service.initialize(request.chats);
        }),
    ],
    [
      WISP_IPC_CHANNELS.createConversation,
      (payload) =>
        toResult(() => {
          const request = parseCreateConversationRequest(payload);
          return service.create(request.conversation, request.model);
        }),
    ],
    [
      WISP_IPC_CHANNELS.updateConversation,
      (payload) =>
        toResult(() => {
          const request = parseUpdateConversationRequest(payload);
          return service.update(request.conversationId, request.changes);
        }),
    ],
    [
      WISP_IPC_CHANNELS.deleteConversation,
      (payload) =>
        toResult(() => {
          const request = parseDeleteConversationRequest(payload);
          return service.delete(request.conversationId);
        }),
    ],
    [
      WISP_IPC_CHANNELS.appendConversationMessage,
      (payload) =>
        toResult(() => {
          const request = parseAppendConversationMessageRequest(payload);
          return service.appendMessage(request.conversationId, request.message);
        }),
    ],
    [
      WISP_IPC_CHANNELS.answerConversationPrompt,
      (payload) =>
        toResult(() => {
          const request = parseAnswerConversationPromptRequest(payload);
          return service.answerPrompt(request.conversationId, request.messageId, request.answer);
        }),
    ],
    [
      WISP_IPC_CHANNELS.markConversationRead,
      (payload) =>
        toResult(() => {
          const request = parseMarkConversationReadRequest(payload);
          return service.markRead(request.conversationId);
        }),
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
