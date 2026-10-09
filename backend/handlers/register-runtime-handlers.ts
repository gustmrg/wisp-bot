export { RUNTIME_OPERATIONS } from "../../shared/runtime-operations.js";
import type { BackendRuntime } from "../runtime.js";
import type { HandlerRouter, SenderAuthorizer } from "./guarded-handlers.js";
import { registerAgentHandlers } from "./register-agent-handlers.js";
import { registerConversationHandlers } from "./register-conversation-handlers.js";
import { registerMcpHandlers } from "./register-mcp-handlers.js";
import { registerMessageQueueHandlers } from "./register-message-queue-handlers.js";
import { registerModelSettingsHandlers } from "./register-model-settings-handlers.js";
import { registerPluginHandlers } from "./register-plugin-handlers.js";
import { registerScheduledMessageHandlers } from "./register-scheduled-message-handlers.js";
import { registerSessionReportHandlers } from "./register-session-report-handlers.js";
import { registerStorageHandlers } from "./register-storage-handlers.js";
import { registerToolPolicyHandlers } from "./register-tool-policy-handlers.js";
import { registerVoiceHandlers } from "./register-voice-handlers.js";
import { registerWorkspaceHandlers } from "./register-workspace-handlers.js";

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
    registerStorageHandlers(router, runtime.storage, authorizeSender),
    // A key added for voice input can make the saved chat model usable, so Wisps re-apply it.
    registerVoiceHandlers(router, runtime.transcription, authorizeSender, () => runtime.reapplySavedModel()),
    registerConversationHandlers(router, conversations, authorizeSender),
    registerScheduledMessageHandlers(router, runtime.scheduledMessages, authorizeSender),
    registerMessageQueueHandlers(router, runtime.messageQueue, authorizeSender),
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
