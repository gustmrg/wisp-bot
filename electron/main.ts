import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";

import { WISP_RELEASES_URL } from "../shared/contracts.js";
import { DEMO_CURRENT_USER } from "../shared/current-user.js";
import { selectAgentMode } from "./backend/agent-mode.js";
import { WispBackendError } from "./backend/backend-error.js";
import { FileLogSink } from "./backend/file-log-sink.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { CompositeLogSink, StructuredLogger } from "./backend/structured-logger.js";
import { resolveAutoInstallSupport } from "./backend/update-capability.js";
import { UpdateService } from "./backend/update-service.js";
import { createBackend } from "./create-backend.js";
import {
  isAllowedExternalUrl,
  isAllowedPermission,
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget,
} from "./security-policy.js";

const productionRendererPath = path.join(__dirname, "../../dist/index.html");
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");
let rendererTarget: RendererTarget | undefined;
let fatalErrorHandled = false;

// Packaged and unpackaged builds share the package name, so Electron hands both
// the same userData directory and dev work would mutate the installed app's
// data. safeStorage also names its Keychain entry after the app, so renaming
// dev keeps its stored credentials on a separate encryption key.
function isolateDevData(): void {
  if (app.isPackaged) return;
  const override = process.env.WISP_DATA_DIR?.trim();
  app.setPath("userData", override ? path.resolve(override) : path.join(app.getPath("appData"), "wisp-bot-dev"));
  app.setName("wisp-bot-dev");
}

isolateDevData();

// Both instances would share the same userData stores and safeStorage key, so a
// second launch (e.g. from a terminal, which bypasses LaunchServices activation)
// must quit and let the running instance surface instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(bootstrap).catch(handleFatalStartupError);
}

async function openExternalUrl(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) throw new WispBackendError("invalid_request", "This link cannot be opened.");
  await shell.openExternal(url);
}

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
    minWidth: 360,
    minHeight: 480,
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

  // The app never spawns windows; rendered links (target="_blank") open in the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void openExternalUrl(url).catch(() => undefined);
    return { action: "deny" };
  });
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

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

async function bootstrap(): Promise<void> {
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    // Amber recolor of build/icon-mac.png so a dev run is distinguishable from
    // the installed (blue) app when both are in the Dock.
    const devIcon = nativeImage.createFromPath(path.join(__dirname, "../../build/icon-mac-dev.png"));
    if (!devIcon.isEmpty()) app.dock.setIcon(devIcon);
  }
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
  const dataDirectory = path.join(app.getPath("userData"), "backend");
  const logger = new StructuredLogger(
    new CompositeLogSink([console, new FileLogSink(path.join(dataDirectory, "logs"))]),
  );
  autoUpdater.channel = app.getVersion().includes("-beta.") ? "beta" : "latest";
  const autoInstallSupported = app.isPackaged
    ? await resolveAutoInstallSupport(process.platform, process.execPath)
    : false;
  const backend = await createBackend({
    dataDirectory,
    ipcMain,
    authorizeSender: isTrustedIpcSender,
    broadcast,
    selectApprovalWindowId: () => {
      const window =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      return window?.webContents.id ?? null;
    },
    openExternal: openExternalUrl,
    openReleasesPage: () => openExternalUrl(WISP_RELEASES_URL),
    encryption: new SafeStorageEncryption(),
    logger,
    agentMode: selectAgentMode(app.isPackaged, process.env.WISP_AGENT_MODE),
    updateService: new UpdateService(autoUpdater, app.getVersion(), app.isPackaged, autoInstallSupported, logger),
    userName: DEMO_CURRENT_USER.givenName,
  });
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    void backend.dispose().finally(() => {
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
