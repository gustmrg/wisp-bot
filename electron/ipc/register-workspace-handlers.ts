import { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { WorkspaceService } from "../../backend/workspace-service.js";
import { registerGuardedHandlers, type HandlerIpcMain, type SenderAuthorizer } from "./guarded-handlers.js";
import { parseConversationRequest, parseSkillRequest } from "../../backend/validators.js";

export function registerWorkspaceHandlers(
  ipcMain: HandlerIpcMain,
  service: WorkspaceService,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  return registerGuardedHandlers(ipcMain, authorizeSender, [
    [WISP_IPC_CHANNELS.getWorkspace, (payload) => service.getView(parseConversationRequest(payload).conversationId)],
    [
      WISP_IPC_CHANNELS.openWorkspaceFolder,
      async (payload) => {
        await service.openWorkspace(parseConversationRequest(payload).conversationId);
        return {};
      },
    ],
    [
      WISP_IPC_CHANNELS.openSkillsFolder,
      async (payload) => {
        await service.openSkills(parseConversationRequest(payload).conversationId);
        return {};
      },
    ],
    [
      WISP_IPC_CHANNELS.attachWorkspaceFiles,
      (payload) => service.attach(parseConversationRequest(payload).conversationId),
    ],
    [WISP_IPC_CHANNELS.listSkills, (payload) => service.listSkills(parseConversationRequest(payload).conversationId)],
    [
      WISP_IPC_CHANNELS.deleteSkill,
      (payload) => {
        const { conversationId, name } = parseSkillRequest(payload);
        return service.deleteSkill(conversationId, name);
      },
    ],
  ]);
}
