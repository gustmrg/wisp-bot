import type { WISP_IPC_CHANNELS } from "../../shared/contracts.js";
import type { BackendRuntime } from "../runtime.js";
import type { HandlerRouter, SenderAuthorizer } from "./guarded-handlers.js";
import { registerAgentHandlers } from "./register-agent-handlers.js";
import { registerConversationHandlers } from "./register-conversation-handlers.js";
import { registerMcpHandlers } from "./register-mcp-handlers.js";
import { registerModelSettingsHandlers } from "./register-model-settings-handlers.js";
import { registerPluginHandlers } from "./register-plugin-handlers.js";
import { registerSessionReportHandlers } from "./register-session-report-handlers.js";
import { registerToolPolicyHandlers } from "./register-tool-policy-handlers.js";
import { registerVoiceHandlers } from "./register-voice-handlers.js";
import { registerWorkspaceHandlers } from "./register-workspace-handlers.js";

/**
 * Every operation `registerRuntimeHandlers` answers. A host that can switch
 * runtimes (the desktop app, between this computer and a server) routes
 * exactly these.
 */
export const RUNTIME_OPERATIONS = [
  "startConversation",
  "sendMessage",
  "abortConversation",
  "applyModel",
  "getConversationModel",
  "manageContext",
  "disposeConversation",
  "getAiSettings",
  "saveAiSettings",
  "removeProviderCredential",
  "getPluginSettings",
  "savePluginSettings",
  "savePluginDefaults",
  "removePlugin",
  "testPluginConnection",
  "getWispPluginAccess",
  "saveWispPluginAccess",
  "getMcpSettings",
  "saveMcpServer",
  "removeMcpServer",
  "testMcpConnection",
  "refreshMcpTools",
  "startMcpSignIn",
  "cancelMcpSignIn",
  "getWispMcpAccess",
  "saveWispMcpAccess",
  "getConversationState",
  "initializeConversations",
  "createConversation",
  "updateConversation",
  "deleteConversation",
  "appendConversationMessage",
  "answerConversationPrompt",
  "markConversationRead",
  "getConversationMessages",
  "searchMessages",
  "getSessionReport",
  "getUsageReport",
  "getUserProfile",
  "saveUserProfile",
  "getToolPolicy",
  "saveToolPolicy",
  "resolveToolApproval",
  "getWorkspace",
  "openWorkspaceFolder",
  "openSkillsFolder",
  "attachWorkspaceFiles",
  "listSkills",
  "deleteSkill",
  "getVoiceSettings",
  "saveVoiceCredential",
  "transcribeAudio",
] as const satisfies ReadonlyArray<keyof typeof WISP_IPC_CHANNELS>;

/**
 * Registers every runtime operation a client can call, whatever the transport.
 * Hosts add their own operations (updates, launch at login) separately.
 */
export function registerRuntimeHandlers(
  router: HandlerRouter,
  runtime: BackendRuntime,
  authorizeSender: SenderAuthorizer,
): { dispose: () => void } {
  const { conversations } = runtime;
  const registrations = [
    registerToolPolicyHandlers(router, runtime.toolAuthorization, authorizeSender),
    registerPluginHandlers(router, runtime.plugins, authorizeSender),
    registerMcpHandlers(router, runtime.mcp, authorizeSender),
    registerModelSettingsHandlers(router, runtime.models, authorizeSender, (selection) =>
      conversations.applyModel(selection),
    ),
    registerSessionReportHandlers(router, runtime.sessionReports, authorizeSender),
    registerWorkspaceHandlers(router, runtime.workspace, authorizeSender),
    // A key added for voice input can make the saved chat model usable, so Wisps re-apply it.
    registerVoiceHandlers(router, runtime.transcription, authorizeSender, () => runtime.reapplySavedModel()),
    registerConversationHandlers(router, conversations, authorizeSender),
    registerAgentHandlers(router, runtime.registry, authorizeSender, (id, model) =>
      runtime.applyConversationModel(id, model),
    ),
  ];
  return {
    dispose: () => {
      for (const registration of registrations) registration.dispose();
    },
  };
}
