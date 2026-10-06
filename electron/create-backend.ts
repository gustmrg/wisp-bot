import type { IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import type { AgentMode } from "../backend/agent-mode.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import type { HandlerEvent, HandlerRouter } from "../backend/handlers/guarded-handlers.js";
import { registerRuntimeHandlers } from "../backend/handlers/register-runtime-handlers.js";
import { createBackendRuntime } from "../backend/runtime.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import type { LaunchAtLoginService } from "./backend/launch-at-login-service.js";
import type { UpdateService } from "./backend/update-service.js";
import { registerLaunchAtLoginHandlers } from "./ipc/register-launch-at-login-handlers.js";
import { registerUpdateHandlers } from "./ipc/register-update-handlers.js";

/** Electron-specific capabilities the backend needs, injected so it can be composed and tested without Electron. */
export interface BackendHost {
  /** Root for every backend store: conversations, sessions, credentials, and policy. */
  dataDirectory: string;
  ipcMain: HandlerRouter;
  authorizeSender: (event: IpcMainInvokeEvent) => boolean;
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
  // Handlers registered on ipcMain only ever receive Electron invoke events.
  const authorize = (event: HandlerEvent): boolean => authorizeSender(event as IpcMainInvokeEvent);
  const handlers = [
    registerLaunchAtLoginHandlers(ipcMain, host.launchAtLoginService, authorize),
    registerUpdateHandlers(ipcMain, host.updateService, authorize, host.openReleasesPage),
    registerRuntimeHandlers(ipcMain, runtime, authorize),
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
