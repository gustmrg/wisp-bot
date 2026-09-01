import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WISP_IPC_CHANNELS, type SequencedConversationAgentEvent } from "../shared/contracts.js";
import { AgentRegistry } from "./backend/agent-registry.js";
import { ConversationRepository } from "./backend/conversation-repository.js";
import { ConversationService } from "./backend/conversation-service.js";
import { ModelService } from "./backend/model-service.js";
import {
  PiConversationAgentFactory,
  SdkPiSessionFactory,
} from "./backend/pi-conversation-agent.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { StructuredLogger } from "./backend/structured-logger.js";
import { ToolAuthorizationBroker } from "./backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "./backend/tool-policy-store.js";
import { registerAgentHandlers } from "./ipc/register-handlers.js";
import { registerConversationHandlers } from "./ipc/register-conversation-handlers.js";
import { registerModelSettingsHandlers } from "./ipc/register-model-settings-handlers.js";
import { registerToolPolicyHandlers } from "./ipc/register-tool-policy-handlers.js";

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

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    const allowedUrl = devServerUrl ?? pathToFileURL(productionRendererPath).href;
    if (navigationUrl !== allowedUrl) event.preventDefault();
  });

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
  const logger = new StructuredLogger();
  const toolPolicyStore = new ToolPolicyStore(path.join(app.getPath("userData"), "backend", "tool-policy.json"));
  await toolPolicyStore.load();
  let conversationService: ConversationService | undefined;
  let agentRegistry: AgentRegistry | undefined;
  const publishAgentEvent = (event: SequencedConversationAgentEvent): void => {
    conversationService?.handleAgentEvent(event);
    if (event.type === "conversation_error") {
      logger.warn("conversation_error", {
        conversationId: event.conversationId,
        requestId: event.requestId,
        code: event.error.code,
        retryable: event.error.retryable,
      });
    } else if (event.type === "tool_approval_requested" || event.type === "tool_approval_resolved") {
      logger.info(event.type, {
        conversationId: event.conversationId,
        approvalId: event.type === "tool_approval_requested" ? event.request.approvalId : event.approvalId,
      });
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WISP_IPC_CHANNELS.agentEvent, event);
    }
  };
  const toolAuthorizationBroker = new ToolAuthorizationBroker(
    toolPolicyStore,
    (event) => agentRegistry?.publishExternalEvent(event),
    {
      selectWindowId: () => {
        const window = BrowserWindow.getFocusedWindow()
          ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        return window?.webContents.id ?? null;
      },
    },
  );
  agentRegistry = new AgentRegistry(
    new PiConversationAgentFactory(new SdkPiSessionFactory(
      modelService.getModelRuntime(),
      toolAuthorizationBroker,
    )),
    publishAgentEvent,
    (conversationId) => toolAuthorizationBroker.cancelConversation(conversationId),
  );
  conversationService = new ConversationService(
    new ConversationRepository({ dataDirectory: path.join(app.getPath("userData"), "backend") }),
    agentRegistry,
    () => toolAuthorizationBroker.listPending(),
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
  const toolPolicyHandlers = registerToolPolicyHandlers(
    ipcMain,
    toolAuthorizationBroker,
    isTrustedIpcSender,
  );
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    toolPolicyHandlers.dispose();
    toolAuthorizationBroker.dispose();
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
