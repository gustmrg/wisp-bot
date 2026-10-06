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
import { hostname } from "node:os";
import path from "node:path";
import { LaunchAtLoginService } from "./backend/launch-at-login-service.js";

import { WISP_RELEASES_URL } from "../shared/contracts.js";
import { selectAgentMode } from "../backend/agent-mode.js";
import { WispBackendError } from "../backend/backend-error.js";
import { FileLogSink } from "../backend/file-log-sink.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { CompositeLogSink, StructuredLogger } from "../backend/structured-logger.js";
import { resolveAutoInstallSupport } from "./backend/update-capability.js";
import { UpdateService } from "./backend/update-service.js";
import { disposeWithin } from "../backend/runtime.js";
import { createBackend } from "./create-backend.js";
import { loadOrCreateLocalMasterKey, migrateKeychainCredentials } from "./local-server/local-credentials.js";
import { ChildProcessLocalServer } from "./local-server/local-server.js";
import { MasterKeyEncryption } from "../server/master-key.js";
import {
  isAllowedExternalUrl,
  isAllowedPermission,
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget,
} from "./security-policy.js";

const productionRendererPath = path.join(__dirname, "../../dist/index.html");
const developmentIconPath = path.join(__dirname, "../../build/icon-mac-dev.png");
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff");
// Agents get this long to settle their last turn on quit before the app exits anyway.
// The local server gives agents ten seconds to settle, then has a few seconds to exit.
const SHUTDOWN_TIMEOUT_MS = 15_000;
let rendererTarget: RendererTarget | undefined;
let fatalErrorHandled = false;
// Set once the backend is ready; opens a window if none is open.
let showWindow: (() => void) | undefined;

// Packaged and unpackaged builds share the package name, so Electron hands both
// the same userData directory and dev work would mutate the installed app's
// data. safeStorage also names its Keychain entry after the app, so renaming
// dev keeps its stored credentials on a separate encryption key.
function isolateDevData(): void {
  if (app.isPackaged) return;
  const override = process.env.WISP_DATA_DIR?.trim();
  app.setPath("userData", override ? path.resolve(override) : path.join(app.getPath("appData"), "wisp-bot-dev"));
  app.setName("wisp-bot-dev");
  if (process.platform === "linux") app.setDesktopName("com.gustavomiranda.wispbot.dev.desktop");
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
    if (!window) {
      // macOS keeps running with every window closed; relaunching should reopen one, like a Dock click.
      showWindow?.();
      return;
    }
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
    ...(!app.isPackaged ? { icon: developmentIconPath } : {}),
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
    const devIcon = nativeImage.createFromPath(developmentIconPath);
    if (!devIcon.isEmpty()) app.dock.setIcon(devIcon);
  }
  const target = resolveRendererTarget(app.isPackaged, process.env.VITE_DEV_SERVER_URL, productionRendererPath);
  rendererTarget = target;
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl ?? requestingOrigin;
    return (
      webContents !== null &&
      BrowserWindow.fromWebContents(webContents) !== null &&
      isAllowedPermission(
        permission,
        requestingUrl,
        details.isMainFrame,
        target,
        details.mediaType ? [details.mediaType] : [],
      )
    );
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      BrowserWindow.fromWebContents(webContents) !== null &&
        isAllowedPermission(
          permission,
          details.requestingUrl,
          details.isMainFrame,
          target,
          "mediaTypes" in details ? (details.mediaTypes ?? []) : [],
        ),
    );
  });
  nativeTheme.themeSource = "system";
  const userData = app.getPath("userData");
  // The local server writes its own logs under backend/logs.
  const logger = new StructuredLogger(new CompositeLogSink([console, new FileLogSink(path.join(userData, "logs"))]));
  autoUpdater.channel = app.getVersion().includes("-beta.") ? "beta" : "latest";
  const autoInstallSupported = app.isPackaged
    ? await resolveAutoInstallSupport(process.platform, process.execPath)
    : false;
  const keychain = new SafeStorageEncryption();
  const masterKey = await loadOrCreateLocalMasterKey(userData, keychain);
  if (masterKey) {
    await migrateKeychainCredentials(
      path.join(userData, "backend"),
      keychain,
      new MasterKeyEncryption(masterKey),
      logger,
    );
  }
  const backend = await createBackend({
    launchAtLoginService: new LaunchAtLoginService({
      platform: process.platform,
      packaged: app.isPackaged,
      home: app.getPath("home"),
      execPath: process.execPath,
      env: process.env,
    }),
    ipcMain,
    authorizeSender: isTrustedIpcSender,
    broadcast,
    openReleasesPage: () => openExternalUrl(WISP_RELEASES_URL),
    hostActions: {
      openExternal: openExternalUrl,
      openPath: async (directory) => {
        const failure = await shell.openPath(directory);
        if (failure) throw new WispBackendError("internal_error", "The folder could not be opened.");
      },
      selectFiles: async () => {
        const options: Electron.OpenDialogOptions = {
          title: "Attach files",
          properties: ["openFile", "multiSelections"],
        };
        const window = BrowserWindow.getFocusedWindow();
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : result.filePaths;
      },
    },
    localServer: new ChildProcessLocalServer({
      scriptPath: path.join(__dirname, "../server/main.js"),
      dataDirectory: userData,
      agentMode: selectAgentMode(app.isPackaged, process.env.WISP_AGENT_MODE),
      ...(masterKey ? { masterKey } : {}),
      logger,
    }),
    encryption: keychain,
    logger,
    updateService: new UpdateService(autoUpdater, app.getVersion(), app.isPackaged, autoInstallSupported, logger),
    connectionsDirectory: userData,
    deviceName: `Wisp on ${hostname()}`,
  });
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    void disposeWithin(() => backend.dispose(), SHUTDOWN_TIMEOUT_MS).then((completed) => {
      if (!completed) logger.warn("shutdown_timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      backendDisposed = true;
      app.quit();
    });
  });
  await createWindow(target);

  showWindow = () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(target).catch(handleFatalStartupError);
  };
  app.on("activate", () => showWindow?.());
}

// A termination signal (logout, `kill`) quits like the menu does, so agents
// settle and SSH tunnels close instead of being left running.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => app.quit());
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
