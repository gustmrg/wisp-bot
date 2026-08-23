import { app, BrowserWindow, nativeTheme } from "electron";
import path from "node:path";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const windowBackground = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

async function createWindow(): Promise<void> {
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
    },
  });

  const syncWindowBackground = (): void => {
    if (!window.isDestroyed()) {
      window.setBackgroundColor(windowBackground());
    }
  };

  nativeTheme.on("updated", syncWindowBackground);
  window.once("closed", () => {
    nativeTheme.off("updated", syncWindowBackground);
  });

  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    return;
  }

  await window.loadFile(path.join(__dirname, "../dist/index.html"));
}

void app.whenReady().then(async () => {
  nativeTheme.themeSource = "system";
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
