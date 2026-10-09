import { access } from "node:fs/promises";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";

import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import { WispBackendError } from "../backend/backend-error.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import {
  registerAuthorizedHandlers,
  registerGuardedHandlers,
  type HandlerEvent,
  type HandlerRouter,
} from "../backend/handlers/guarded-handlers.js";
import { RUNTIME_OPERATIONS } from "../backend/handlers/register-runtime-handlers.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import type { RemoteTransport } from "../client/remote-session.js";
import type { SshConnectionProfile } from "../shared/connections.js";
import type { HostRequest, HostResponse } from "../shared/remote-protocol.js";
import type { LaunchAtLoginService } from "./backend/launch-at-login-service.js";
import type { UpdateService } from "./backend/update-service.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { ConnectionStore } from "./connections/connection-store.js";
import type { SshAskpass } from "./connections/ssh-askpass.js";
import type { SshInteraction } from "./connections/ssh-auth.js";
import { installRemoteServer } from "./connections/ssh-install.js";
import { openSshTunnel } from "./connections/ssh-tunnel.js";
import { registerLaunchAtLoginHandlers } from "./ipc/register-launch-at-login-handlers.js";
import { registerUpdateHandlers } from "./ipc/register-update-handlers.js";
import type { LocalServer } from "./local-server/local-server.js";

/** What the local server may ask the app to do on this computer's screen. */
export interface HostActions {
  openExternal: (url: string) => Promise<void>;
  /** Opens a folder of the local server in the system file manager. */
  openPath: (directory: string) => Promise<void>;
  /** Shows a native multi-file picker; resolves with absolute paths, empty when dismissed. */
  selectFiles: () => Promise<ReadonlyArray<string>>;
}

/** Electron-specific capabilities, injected so the desktop backend can be composed and tested without Electron. */
export interface BackendHost {
  ipcMain: HandlerRouter;
  authorizeSender: (event: IpcMainInvokeEvent) => boolean;
  /** Sends a push channel payload to every open renderer window. */
  broadcast: (channel: string, payload: unknown) => void;
  openReleasesPage: () => Promise<void>;
  hostActions: HostActions;
  /** The Wisp server on this computer. */
  localServer: LocalServer;
  /** Encrypts pairing credentials; the system keychain in the app. */
  encryption: EncryptionService;
  logger: StructuredLogger;
  updateService: UpdateService;
  launchAtLoginService: LaunchAtLoginService;
  /** Where connection profiles and encrypted pairing credentials are kept. */
  connectionsDirectory: string;
  /** How this computer introduces itself when pairing with a server. */
  deviceName: string;
  /** The version of this app; the server it installs on another machine is the same version. */
  appVersion: string;
  /**
   * Starts the helper that lets OpenSSH ask the person for a password, a key
   * passphrase, or to trust a host key. Without one, SSH runs in BatchMode.
   */
  startSshAskpass?: () => Promise<SshAskpass | undefined>;
  /** Installs the server over SSH; tests substitute a fake. */
  installServer?: (
    profile: SshConnectionProfile,
    onProgress: (message: string) => void,
    signal: AbortSignal,
    interaction: SshInteraction | undefined,
  ) => Promise<void>;
  /** Opens an SSH tunnel to a server; tests substitute a fake. */
  openSshTunnel?: (
    profile: SshConnectionProfile,
    signal: AbortSignal,
    interaction: SshInteraction | undefined,
  ) => Promise<RemoteTransport>;
}

export interface Backend {
  /** Removes IPC handlers, disconnects, and stops the local server after its Wisps settle. */
  dispose(): Promise<void>;
}

/**
 * Exposes the active Wisp server to renderer windows over IPC. The app is
 * always a client: on this computer it starts a server as a child process,
 * started only while it is the chosen connection, and reaches it like a server
 * over SSH or HTTPS.
 */
export async function createBackend(host: BackendHost): Promise<Backend> {
  const { ipcMain, authorizeSender, broadcast } = host;
  const store = new ConnectionStore(host.connectionsDirectory, host.encryption);
  await store.load();
  const askpass = await host.startSshAskpass?.().catch((error: Error) => {
    host.logger.warn("ssh_askpass_unavailable", { message: error.message });
    return undefined;
  });
  const interaction: SshInteraction | undefined = askpass && {
    askpass,
    ask: (prompt, signal) => manager.askSsh(prompt, signal),
    logger: host.logger,
  };
  const openTunnel = host.openSshTunnel ?? ((profile, signal) => openSshTunnel(profile, { signal, interaction }));
  const install =
    host.installServer ??
    ((profile, onProgress, signal) =>
      installRemoteServer(profile, { version: host.appVersion, onProgress, signal, interaction }));
  const manager = new ConnectionManager({
    store,
    localServer: host.localServer,
    onHostRequest: (request) => runHostAction(host.hostActions, request),
    selectFiles: () => host.hostActions.selectFiles(),
    openSshTunnel: (profile, signal) => openTunnel(profile, signal, interaction),
    installServer: (profile, onProgress, signal) => install(profile, onProgress, signal, interaction),
    deviceName: host.deviceName,
    broadcast,
    logger: host.logger,
    hasLocalData: () => hasLocalData(host.connectionsDirectory),
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
        return [channel, (payload) => manager.dispatch(channel, payload)] as const;
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
      [WISP_IPC_CHANNELS.installServer, (payload) => manager.installServer(connectionId(payload))],
      [WISP_IPC_CHANNELS.cancelServerInstall, () => manager.cancelInstall()],
      [WISP_IPC_CHANNELS.answerSshPrompt, (payload) => manager.answerSshPrompt(payload)],
    ]),
  ];
  try {
    await manager.start();
  } catch (error) {
    for (const registration of handlers) registration.dispose();
    unsubscribeUpdateState();
    await askpass?.close();
    throw error;
  }

  return {
    dispose: async () => {
      // Stop accepting renderer requests before the backend winds down.
      for (const registration of handlers) registration.dispose();
      unsubscribeUpdateState();
      await manager.dispose();
      await askpass?.close();
    },
  };
}

/** Conversations from a version that ran Wisps on this computer without asking. */
async function hasLocalData(userData: string): Promise<boolean> {
  for (const name of ["conversations.sqlite", "conversations.json"]) {
    try {
      await access(path.join(userData, "backend", name));
      return true;
    } catch {
      // Not there.
    }
  }
  return false;
}

async function runHostAction(actions: HostActions, request: HostRequest): Promise<HostResponse> {
  if (request.kind === "openPath") await actions.openPath(request.path);
  else if (request.kind === "openExternal") await actions.openExternal(request.url);
  else return { ok: true, value: await actions.selectFiles() };
  return { ok: true };
}

function connectionId(payload: unknown): string {
  const id = (payload as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    throw new WispBackendError("invalid_request", "The connection is invalid.");
  }
  return id;
}
