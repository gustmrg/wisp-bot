import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { hostname, userInfo } from "node:os";

import { WISP_IPC_CHANNELS, type SequencedConversationAgentEvent } from "../shared/contracts.js";
import { CONNECTION_IPC_CHANNELS } from "../shared/connections.js";
import { REMOTE_STATE_CHANNEL } from "../shared/remote-protocol.js";
import { createBackend } from "../backend/bootstrap.js";
import { selectAgentMode } from "../backend/agent-mode.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { StructuredLogger } from "../backend/structured-logger.js";
import { UpdateService } from "./backend/update-service.js";
import { ConnectionManager } from "./connections/connection-manager.js";
import { ConnectionProfileStore } from "./connections/profile-store.js";
import { OpenSshTransport } from "./connections/ssh-tunnel.js";
import { registerBackendHandlers } from "./ipc/register-backend-handlers.js";
import { registerConnectionHandlers } from "./ipc/register-connection-handlers.js";
import { registerUpdateHandlers } from "./ipc/register-update-handlers.js";
import {
  isAllowedPermission,
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget,
} from "./security-policy.js";

const productionRendererPath = path.join(__dirname, "../../dist/index.html");
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");
let rendererTarget: RendererTarget | undefined;
let fatalErrorHandled = false;

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;

  try {
    return rendererTarget ? isAllowedRendererUrl(event.senderFrame.url, rendererTarget) : false;
  } catch {
    return false;
  }
}

async function createWindow(target: RendererTarget): Promise<void> {
  const window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
  });

  const syncWindowBackground = (): void => {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(windowBackground());
    }
  };

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, target)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, navigationUrl) => {
    if (!isAllowedRendererUrl(navigationUrl, target)) event.preventDefault();
  });

  nativeTheme.on("updated", syncWindowBackground);
  window.once("closed", () => {
    nativeTheme.off("updated", syncWindowBackground);
  });

  try {
    if (target.kind === "development") await window.loadURL(target.url);
    else await window.loadFile(target.filePath);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

function handleFatalStartupError(error: unknown): void {
  if (fatalErrorHandled) return;
  fatalErrorHandled = true;
  const code = error instanceof Error ? error.name : "UnknownError";
  console.error("Wisp startup failed", { code });
  dialog.showErrorBox(
    "Wisp could not start",
    "The application could not load its local interface. Please restart Wisp.",
  );
  app.quit();
}

async function bootstrap(): Promise<void> {
  const target = resolveRendererTarget(app.isPackaged, process.env.VITE_DEV_SERVER_URL, productionRendererPath);
  rendererTarget = target;
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl ?? requestingOrigin;
    return (
      webContents !== null &&
      BrowserWindow.fromWebContents(webContents) !== null &&
      isAllowedPermission(permission, requestingUrl, details.isMainFrame, target)
    );
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      BrowserWindow.fromWebContents(webContents) !== null &&
        isAllowedPermission(permission, details.requestingUrl, details.isMainFrame, target),
    );
  });
  nativeTheme.themeSource = "system";
  const logger = new StructuredLogger();
  const broadcast = (channel: string, value: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, value);
    }
  };
  const publishAgentEvent = (event: SequencedConversationAgentEvent): void => {
    if (event.type === "conversation_error") {
      logger.warn("conversation_error", {
        conversationId: event.conversationId,
        requestId: event.requestId,
        code: event.error.code,
        retryable: event.error.retryable,
      });
    }
    broadcast(WISP_IPC_CHANNELS.agentEvent, event);
  };
  const encryption = new SafeStorageEncryption();
  const local = await createBackend({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    encryption,
    userName: userInfo().username,
    agentMode: selectAgentMode(app.isPackaged, process.env.WISP_AGENT_MODE),
    fakeLatencyMs: 350,
  });
  const connectionsDirectory = path.join(app.getPath("userData"), "connections");
  const profiles = new ConnectionProfileStore(connectionsDirectory, encryption);
  await profiles.load();
  const manager = new ConnectionManager(
    local.api,
    profiles,
    new OpenSshTransport(connectionsDirectory),
    (url) => shell.openExternal(url),
    `Wisp desktop (${hostname()})`,
  );
  const subscriptions = [
    local.api.subscribeToAgentEvents((event) => {
      if (manager.getState().profileId === "local") publishAgentEvent(event);
    }),
    local.api.subscribeToConversationState!((state) => {
      if (manager.getState().profileId === "local") broadcast(REMOTE_STATE_CHANNEL, state);
    }),
    manager.subscribe((state) => broadcast(CONNECTION_IPC_CHANNELS.state, state)),
    manager.subscribeToAgentEvents(publishAgentEvent),
    manager.subscribeToConversationState((state) => broadcast(REMOTE_STATE_CHANNEL, state)),
  ];
  autoUpdater.channel = app.getVersion().includes("-beta.") ? "beta" : "latest";
  const updateService = new UpdateService(autoUpdater, app.getVersion(), app.isPackaged);
  subscriptions.push(updateService.subscribe((state) => broadcast(WISP_IPC_CHANNELS.updateState, state)));
  const backendHandlers = registerBackendHandlers(ipcMain, () => manager.getBackend(), isTrustedIpcSender);
  const connectionHandlers = registerConnectionHandlers(ipcMain, manager, isTrustedIpcSender);
  const updateHandlers = registerUpdateHandlers(ipcMain, updateService, isTrustedIpcSender);
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    backendHandlers.dispose();
    connectionHandlers.dispose();
    updateHandlers.dispose();
    for (const unsubscribe of subscriptions) unsubscribe();
    // Remote sessions belong to the server; disconnecting disposes only local transport resources.
    manager.dispose();
    void local.dispose().finally(() => {
      backendDisposed = true;
      app.quit();
    });
  });
  await createWindow(target);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(target).catch(handleFatalStartupError);
    }
  });
}

app.whenReady().then(bootstrap).catch(handleFatalStartupError);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
