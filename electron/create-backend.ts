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
import type { SshConfigHost, SshConnectionProfile, TailnetMachine } from "../shared/connections.js";
import type { HostRequest, HostResponse } from "../shared/remote-protocol.js";
import type { LaunchAtLoginService } from "./backend/launch-at-login-service.js";
import type { UpdateService } from "./backend/update-service.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { ConnectionStore } from "./connections/connection-store.js";
import { AskpassBroker } from "./connections/ssh-askpass.js";
import { checkSshServer } from "./connections/ssh-check.js";
import { listSshConfigHosts } from "./connections/ssh-config.js";
import { installRemoteServer } from "./connections/ssh-install.js";
import { WispSshKey } from "./connections/ssh-key.js";
import { enableLinger } from "./connections/ssh-linger.js";
import { listTailnetMachines } from "./connections/tailnet.js";
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
  /** The OpenSSH client for every ssh Wisp runs; tests substitute a fake. */
  sshPath?: string;
  /** The Node.js that answers OpenSSH's questions; Electron's own by default. */
  askpassExecPath?: string;
  /** Installs the server over SSH; tests substitute a fake. */
  installServer?: (
    profile: SshConnectionProfile,
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Opens an SSH tunnel to a server; tests substitute a fake. */
  openSshTunnel?: (profile: SshConnectionProfile, signal: AbortSignal) => Promise<RemoteTransport>;
  /** Lists the machines in ~/.ssh/config; tests substitute a fake ssh and home. */
  listSshHosts?: () => Promise<SshConfigHost[]>;
  /** Lists the machines on the tailnet; tests substitute a fake. */
  listTailnetMachines?: () => Promise<TailnetMachine[]>;
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
  const { sshPath } = host;
  // Wisp's own key, for servers that only accepted a password.
  const key = new WispSshKey(path.join(host.connectionsDirectory, "ssh", "wisp_ed25519"));
  const askpass = new AskpassBroker((prompt) => manager.askSsh(prompt), host.askpassExecPath);
  const manager: ConnectionManager = new ConnectionManager({
    store,
    localServer: host.localServer,
    onHostRequest: (request) => runHostAction(host.hostActions, request),
    selectFiles: () => host.hostActions.selectFiles(),
    openSshTunnel:
      host.openSshTunnel ??
      ((profile, signal) => openSshTunnel(profile, { sshPath, identityFile: key.identityFile, signal })),
    installServer:
      host.installServer ??
      ((profile, onProgress, signal) =>
        installRemoteServer(profile, {
          sshPath,
          identityFile: key.identityFile,
          version: host.appVersion,
          onProgress,
          signal,
        })),
    checkSshServer: async (profile, signal, onBrowserCheck) =>
      checkSshServer(profile, {
        sshPath,
        askpassEnv: await askpass.env(),
        key,
        deviceName: host.deviceName,
        onBrowserCheck,
        signal,
      }),
    enableLinger: (profile, askPassword, signal) =>
      enableLinger(profile, { sshPath, identityFile: key.identityFile, askPassword, signal }),
    appVersion: host.appVersion,
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
      [WISP_IPC_CHANNELS.listSshHosts, () => (host.listSshHosts ?? (() => listSshConfigHosts({ sshPath })))()],
      [WISP_IPC_CHANNELS.checkSshServer, (payload) => manager.checkSsh(connectionId(payload))],
      [WISP_IPC_CHANNELS.listTailnetMachines, () => (host.listTailnetMachines ?? listTailnetMachines)()],
      [WISP_IPC_CHANNELS.enableLinger, (payload) => manager.enableLinger(connectionId(payload))],
      [WISP_IPC_CHANNELS.cancelSshCheck, () => manager.cancelSshCheck()],
      [
        WISP_IPC_CHANNELS.answerSshPrompt,
        (payload) => {
          const { id, answer } = (payload ?? {}) as { id?: unknown; answer?: unknown };
          if (
            !Number.isSafeInteger(id) ||
            (answer !== undefined && (typeof answer !== "string" || answer.length > 1024))
          ) {
            throw new WispBackendError("invalid_request", "The answer is invalid.");
          }
          return manager.answerSshPrompt(id as number, answer as string | undefined);
        },
      ],
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
      await askpass.dispose();
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
