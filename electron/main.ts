import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WISP_IPC_CHANNELS, type ConversationAgentEvent } from "../shared/contracts.js";
import { AgentRegistry } from "./backend/agent-registry.js";
import { ConversationRepository } from "./backend/conversation-repository.js";
import { ConversationService } from "./backend/conversation-service.js";
import { ModelService } from "./backend/model-service.js";
import {
  PiConversationAgentFactory,
  SdkPiSessionFactory,
} from "./backend/pi-conversation-agent.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { registerAgentHandlers } from "./ipc/register-handlers.js";
import { registerConversationHandlers } from "./ipc/register-conversation-handlers.js";
import { registerModelSettingsHandlers } from "./ipc/register-model-settings-handlers.js";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const productionRendererPath = path.join(__dirname, "../../dist/index.html");
const windowBackground = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;

  try {
    const senderUrl = new URL(event.senderFrame.url);
    if (devServerUrl) return senderUrl.origin === new URL(devServerUrl).origin;
    return senderUrl.href === pathToFileURL(productionRendererPath).href;
  } catch {
    return false;
  }
}

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
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
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

  await window.loadFile(productionRendererPath);
}

void app.whenReady().then(async () => {
  nativeTheme.themeSource = "system";
  const modelService = await ModelService.create({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    encryption: new SafeStorageEncryption(),
  });
  const publishAgentEvent = (event: ConversationAgentEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WISP_IPC_CHANNELS.agentEvent, event);
    }
  };
  const agentRegistry = new AgentRegistry(
    new PiConversationAgentFactory(new SdkPiSessionFactory(modelService.getModelRuntime())),
    publishAgentEvent,
  );
  const conversationService = new ConversationService(
    new ConversationRepository({ dataDirectory: path.join(app.getPath("userData"), "backend") }),
    agentRegistry,
  );
  await conversationService.start(await modelService.getSelection());
  const agentHandlers = registerAgentHandlers(
    ipcMain,
    agentRegistry,
    isTrustedIpcSender,
  );
  const conversationHandlers = registerConversationHandlers(
    ipcMain,
    conversationService,
    isTrustedIpcSender,
  );
  const modelSettingsHandlers = registerModelSettingsHandlers(
    ipcMain,
    modelService,
    isTrustedIpcSender,
    (selection) => conversationService.applyModel(selection),
  );
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    modelSettingsHandlers.dispose();
    conversationHandlers.dispose();
    void agentHandlers.dispose().finally(() => {
      backendDisposed = true;
      app.quit();
    });
  });
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
