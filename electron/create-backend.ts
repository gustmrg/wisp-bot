import type { IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import { WispBackendError } from "../backend/backend-error.js";
import type { AgentMode } from "../backend/agent-mode.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import {
  registerAuthorizedHandlers,
  registerGuardedHandlers,
  type HandlerEvent,
  type HandlerRouter,
} from "../backend/handlers/guarded-handlers.js";
import { registerRuntimeHandlers, RUNTIME_OPERATIONS } from "../backend/handlers/register-runtime-handlers.js";
import { createBackendRuntime } from "../backend/runtime.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import type { LaunchAtLoginService } from "./backend/launch-at-login-service.js";
import type { UpdateService } from "./backend/update-service.js";
import type { RemoteTransport } from "../client/remote-session.js";
import type { SshConnectionProfile } from "../shared/connections.js";
import { ConnectionManager, type OperationListener } from "./connections/connection-manager.js";
import { ConnectionStore } from "./connections/connection-store.js";
import { openSshTunnel } from "./connections/ssh-tunnel.js";
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
  /** Where connection profiles and encrypted pairing credentials are kept. */
  connectionsDirectory: string;
  /** How this computer introduces itself when pairing with a server. */
  deviceName: string;
  /** Opens an SSH tunnel to a server; tests substitute a fake. */
  openSshTunnel?: (profile: SshConnectionProfile, signal: AbortSignal) => Promise<RemoteTransport>;
}

export interface Backend {
  /** Removes IPC handlers, then stops the local backend or disconnects from the server. */
  dispose(): Promise<void>;
}

/**
 * Exposes the active backend to renderer windows over IPC. The backend runs on
 * this computer, started only while it is the chosen connection, or on a Wisp
 * server; the renderer calls the same operations either way.
 */
export async function createBackend(host: BackendHost): Promise<Backend> {
  const { ipcMain, authorizeSender, broadcast } = host;
  const store = new ConnectionStore(host.connectionsDirectory, host.encryption);
  await store.load();
  const manager = new ConnectionManager({
    store,
    createLocalBackend: (publish) => createLocalBackend(host, publish),
    openSshTunnel: host.openSshTunnel ?? ((profile, signal) => openSshTunnel(profile, { signal })),
    deviceName: host.deviceName,
    broadcast,
    logger: host.logger,
  });
  const unsubscribeUpdateState = host.updateService.subscribe((state) =>
    broadcast(WISP_IPC_CHANNELS.updateState, state),
  );
  // Handlers registered on ipcMain only ever receive Electron invoke events.
  const authorize = (event: HandlerEvent): boolean => authorizeSender(event as IpcMainInvokeEvent);
  const handlers = [
    registerLaunchAtLoginHandlers(ipcMain, host.launchAtLoginService, authorize),
    registerUpdateHandlers(ipcMain, host.updateService, authorize, host.openReleasesPage),
    registerAuthorizedHandlers(
      ipcMain,
      authorize,
      RUNTIME_OPERATIONS.map((operation) => {
        const channel = WISP_IPC_CHANNELS[operation];
        return [channel, (payload, event) => manager.dispatch(channel, event, payload)] as const;
      }),
    ),
    registerGuardedHandlers(ipcMain, authorize, [
      [WISP_IPC_CHANNELS.getConnections, () => manager.view()],
      [WISP_IPC_CHANNELS.saveConnection, (payload) => manager.save(payload)],
      [WISP_IPC_CHANNELS.removeConnection, (payload) => manager.remove(connectionId(payload))],
      [
        WISP_IPC_CHANNELS.activateConnection,
        (payload) => {
          const pairingCode = (payload as { pairingCode?: unknown } | null)?.pairingCode;
          if (pairingCode !== undefined && (typeof pairingCode !== "string" || pairingCode.length > 64)) {
            throw new WispBackendError("invalid_request", "The pairing code is invalid.");
          }
          return manager.activate(connectionId(payload), pairingCode);
        },
      ],
      [WISP_IPC_CHANNELS.retryConnection, () => manager.retry()],
    ]),
  ];
  try {
    await manager.start();
  } catch (error) {
    for (const registration of handlers) registration.dispose();
    unsubscribeUpdateState();
    throw error;
  }

  return {
    dispose: async () => {
      // Stop accepting renderer requests before the backend winds down.
      for (const registration of handlers) registration.dispose();
      unsubscribeUpdateState();
      await manager.dispose();
    },
  };
}

/** Starts the shared runtime on this computer, with its operations in a channel table. */
async function createLocalBackend(
  host: BackendHost,
  publish: (channel: string, payload: unknown) => void,
): Promise<{ operations: Map<string, OperationListener>; dispose(): Promise<void> }> {
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
    onAgentEvent: (event) => publish(WISP_IPC_CHANNELS.agentEvent, event),
    onConversationChanged: (delta) => publish(WISP_IPC_CHANNELS.conversationChanged, delta),
    onMcpSettingsChanged: (view) => publish(WISP_IPC_CHANNELS.mcpSettingsChanged, view),
  });
  const operations = new Map<string, OperationListener>();
  // The IPC layer has already checked the sender before routing here.
  registerRuntimeHandlers(
    {
      handle: (channel, listener) => void operations.set(channel, listener),
      removeHandler: (channel) => void operations.delete(channel),
    },
    runtime,
    () => true,
  );
  return { operations, dispose: () => runtime.dispose() };
}

function connectionId(payload: unknown): string {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw new WispBackendError("invalid_request", "The connection is invalid.");
  }
  return id;
}
