import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import type { AgentMode } from "../backend/agent-mode.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import { createBackendRuntime } from "../backend/runtime.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import type { LaunchAtLoginService } from "./backend/launch-at-login-service.js";
import type { UpdateService } from "./backend/update-service.js";
import type { HandlerIpcMain, SenderAuthorizer } from "./ipc/guarded-handlers.js";
import { registerConversationHandlers } from "./ipc/register-conversation-handlers.js";
import { registerAgentHandlers } from "./ipc/register-handlers.js";
import { registerLaunchAtLoginHandlers } from "./ipc/register-launch-at-login-handlers.js";
import { registerMcpHandlers } from "./ipc/register-mcp-handlers.js";
import { registerModelSettingsHandlers } from "./ipc/register-model-settings-handlers.js";
import { registerPluginHandlers } from "./ipc/register-plugin-handlers.js";
import { registerSessionReportHandlers } from "./ipc/register-session-report-handlers.js";
import { registerToolPolicyHandlers } from "./ipc/register-tool-policy-handlers.js";
import { registerUpdateHandlers } from "./ipc/register-update-handlers.js";
import { registerVoiceHandlers } from "./ipc/register-voice-handlers.js";
import { registerWorkspaceHandlers } from "./ipc/register-workspace-handlers.js";

/** Electron-specific capabilities the backend needs, injected so it can be composed and tested without Electron. */
export interface BackendHost {
  /** Root for every backend store: conversations, sessions, credentials, and policy. */
  dataDirectory: string;
  ipcMain: HandlerIpcMain;
  authorizeSender: SenderAuthorizer;
  /** Sends a push channel payload to every open renderer window. */
  broadcast: (channel: string, payload: unknown) => void;
  /** The window that should own a new tool approval prompt, or null when none is open. */
  selectApprovalWindowId: () => number | null;
  openExternal: (url: string) => Promise<void>;
  openReleasesPage: () => Promise<void>;
  /** Opens a backend-owned local folder in the system file manager. */
  openPath: (directory: string) => Promise<void>;
  /** Shows a native multi-file picker; resolves with absolute paths, empty when dismissed. */
  selectFiles: () => Promise<ReadonlyArray<string>>;
  encryption: EncryptionService;
  logger: StructuredLogger;
  agentMode: AgentMode;
  /** The running application version, reported to remote MCP servers. */
  appVersion: string;
  updateService: UpdateService;
  launchAtLoginService: LaunchAtLoginService;
  userName?: string;
  /** Refresh model catalogs over the network in the background after startup. Defaults to true. */
  allowModelNetwork?: boolean;
}

export interface Backend {
  /** Removes IPC handlers, then disposes the backend runtime. */
  dispose(): Promise<void>;
}

/** Composes the shared backend runtime and exposes it to renderer windows over IPC. */
export async function createBackend(host: BackendHost): Promise<Backend> {
  const { ipcMain, authorizeSender, broadcast } = host;
  const runtime = await createBackendRuntime({
    dataDirectory: host.dataDirectory,
    encryption: host.encryption,
    logger: host.logger,
    agentMode: host.agentMode,
    appVersion: host.appVersion,
    ...(host.userName === undefined ? {} : { userName: host.userName }),
    ...(host.allowModelNetwork === undefined ? {} : { allowModelNetwork: host.allowModelNetwork }),
    selectApprovalWindowId: host.selectApprovalWindowId,
    openExternal: host.openExternal,
    openPath: host.openPath,
    selectFiles: host.selectFiles,
    onAgentEvent: (event) => broadcast(WISP_IPC_CHANNELS.agentEvent, event),
    onConversationChanged: (delta) => broadcast(WISP_IPC_CHANNELS.conversationChanged, delta),
    onMcpSettingsChanged: (view) => broadcast(WISP_IPC_CHANNELS.mcpSettingsChanged, view),
  });
  const unsubscribeUpdateState = host.updateService.subscribe((state) =>
    broadcast(WISP_IPC_CHANNELS.updateState, state),
  );
  const { conversations } = runtime;
  const handlers = [
    registerLaunchAtLoginHandlers(ipcMain, host.launchAtLoginService, authorizeSender),
    registerToolPolicyHandlers(ipcMain, runtime.toolAuthorization, authorizeSender),
    registerPluginHandlers(ipcMain, runtime.plugins, authorizeSender),
    registerMcpHandlers(ipcMain, runtime.mcp, authorizeSender),
    registerUpdateHandlers(ipcMain, host.updateService, authorizeSender, host.openReleasesPage),
    registerModelSettingsHandlers(ipcMain, runtime.models, authorizeSender, (selection) =>
      conversations.applyModel(selection),
    ),
    registerSessionReportHandlers(ipcMain, runtime.sessionReports, authorizeSender),
    registerWorkspaceHandlers(ipcMain, runtime.workspace, authorizeSender),
    // A key added for voice input can make the saved chat model usable, so Wisps re-apply it.
    registerVoiceHandlers(ipcMain, runtime.transcription, authorizeSender, () => runtime.reapplySavedModel()),
    registerConversationHandlers(ipcMain, conversations, authorizeSender),
    registerAgentHandlers(ipcMain, runtime.registry, authorizeSender, (id, model) =>
      runtime.applyConversationModel(id, model),
    ),
  ];

  return {
    dispose: async () => {
      // Stop accepting renderer requests before the runtime winds down.
      for (const registration of handlers) registration.dispose();
      unsubscribeUpdateState();
      await runtime.dispose();
    },
  };
}
