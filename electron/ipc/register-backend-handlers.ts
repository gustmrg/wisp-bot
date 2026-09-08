import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { sanitizeBackendError } from "../../backend/backend-error.js";
import { normalizeToolPolicy } from "../../backend/tool-policy-store.js";
import type { BackendApi } from "../../shared/backend-api.js";
import { type BackendResult, WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import * as validators from "../../shared/validators.js";
import type { SenderAuthorizer } from "./register-handlers.js";

type Registration = [string, (api: BackendApi, payload: unknown) => Promise<BackendResult<unknown>>];
/** A closed operation allowlist; the renderer never selects a URL or arbitrary backend method. */
export function registerBackendHandlers(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  getBackend: () => BackendApi | null,
  authorize: SenderAuthorizer,
): { dispose(): void } {
  const registrations: Registration[] = [
    [WISP_IPC_CHANNELS.startConversation, (api, p) => api.startConversation(validators.parseConversationRequest(p))],
    [WISP_IPC_CHANNELS.sendMessage, (api, p) => api.sendMessage(validators.parseSendMessageRequest(p))],
    [WISP_IPC_CHANNELS.abortConversation, (api, p) => api.abortConversation(validators.parseConversationRequest(p))],
    [WISP_IPC_CHANNELS.applyModel, (api, p) => api.applyModel(validators.parseApplyModelRequest(p))],
    [
      WISP_IPC_CHANNELS.getConversationModel,
      (api, p) => api.getConversationModel(validators.parseConversationRequest(p)),
    ],
    [WISP_IPC_CHANNELS.manageContext, (api, p) => api.manageContext(validators.parseContextRequest(p))],
    [
      WISP_IPC_CHANNELS.disposeConversation,
      (api, p) => api.disposeConversation(validators.parseConversationRequest(p)),
    ],
    [WISP_IPC_CHANNELS.getAiSettings, (api) => api.getAiSettings()],
    [WISP_IPC_CHANNELS.saveAiSettings, (api, p) => api.saveAiSettings(validators.parseSaveAiSettingsRequest(p))],
    [
      WISP_IPC_CHANNELS.removeProviderCredential,
      (api, p) => api.removeProviderCredential(validators.parseRemoveProviderCredentialRequest(p)),
    ],
    [WISP_IPC_CHANNELS.getConversationState, (api) => api.getConversationState()],
    [
      WISP_IPC_CHANNELS.initializeConversations,
      (api, p) => api.initializeConversations(validators.parseInitializeConversationsRequest(p)),
    ],
    [
      WISP_IPC_CHANNELS.createConversation,
      (api, p) => api.createConversation(validators.parseCreateConversationRequest(p)),
    ],
    [
      WISP_IPC_CHANNELS.updateConversation,
      (api, p) => api.updateConversation(validators.parseUpdateConversationRequest(p)),
    ],
    [
      WISP_IPC_CHANNELS.deleteConversation,
      (api, p) => api.deleteConversation(validators.parseDeleteConversationRequest(p)),
    ],
    [
      WISP_IPC_CHANNELS.appendConversationMessage,
      (api, p) => api.appendConversationMessage(validators.parseAppendConversationMessageRequest(p)),
    ],
    [
      WISP_IPC_CHANNELS.answerConversationPrompt,
      (api, p) => api.answerConversationPrompt(validators.parseAnswerConversationPromptRequest(p)),
    ],
    [
      WISP_IPC_CHANNELS.markConversationRead,
      (api, p) => api.markConversationRead(validators.parseMarkConversationReadRequest(p)),
    ],
    [WISP_IPC_CHANNELS.getSessionReport, (api, p) => api.getSessionReport(validators.parseConversationRequest(p))],
    [WISP_IPC_CHANNELS.getUsageReport, (api, p) => api.getUsageReport(validators.parseUsageReportRequest(p))],
    [WISP_IPC_CHANNELS.getToolPolicy, (api) => api.getToolPolicy()],
    [
      WISP_IPC_CHANNELS.saveToolPolicy,
      (api, p) => api.saveToolPolicy(normalizeToolPolicy(p), validators.parseExpectedRevision(p)),
    ],
    [
      WISP_IPC_CHANNELS.resolveToolApproval,
      (api, p) => api.resolveToolApproval(validators.parseResolveToolApprovalRequest(p)),
    ],
    [
      "wisp:conversations:messages",
      async (api, payload) => {
        const { conversationId } = validators.parseConversationRequest(payload);
        const request = payload as { before?: unknown; limit?: unknown };
        if (
          (request.before !== undefined &&
            (typeof request.before !== "string" || !/^\d{1,19}$/.test(request.before))) ||
          (request.limit !== undefined &&
            (!Number.isInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 200))
        )
          return {
            ok: false,
            error: { code: "invalid_request", message: "The message cursor is invalid.", retryable: false },
          };
        if (api.getConversationMessages)
          return api.getConversationMessages({
            conversationId,
            before: request.before as string | undefined,
            limit: request.limit as number | undefined,
          });
        const state = await api.getConversationState();
        if (!state.ok) return state;
        return { ok: true, value: { messages: state.value.chats[conversationId]?.messages ?? [], nextCursor: null } };
      },
    ],
    ["wisp:connections:refresh", (api) => api.refreshConnection?.() ?? api.getConversationState()],
  ];
  for (const [channel, handler] of registrations)
    ipc.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown): Promise<BackendResult<unknown>> => {
      if (!authorize(event))
        return {
          ok: false,
          error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
        };
      const api = getBackend();
      if (!api)
        return {
          ok: false,
          error: { code: "transport_unavailable", message: "Connect to a backend first.", retryable: true },
        };
      try {
        const result = await handler(api, payload);
        if (api !== getBackend())
          return {
            ok: false,
            error: {
              code: "transport_unavailable",
              message: "The connection changed before the request completed.",
              retryable: true,
            },
          };
        return result;
      } catch (error) {
        return { ok: false, error: sanitizeBackendError(error) };
      }
    });
  return {
    dispose: () => {
      for (const [channel] of registrations) ipc.removeHandler(channel);
    },
  };
}
