import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";

import { WISP_IPC_CHANNELS, type SequencedConversationAgentEvent } from "../shared/contracts.js";
import { DEMO_CURRENT_USER } from "../shared/current-user.js";
import { AgentRegistry } from "./backend/agent-registry.js";
import { selectAgentMode } from "./backend/agent-mode.js";
import { ConversationRepository } from "./backend/conversation-repository.js";
import { ConversationService } from "./backend/conversation-service.js";
import type { ConversationAgentFactory } from "./backend/conversation-agent.js";
import { FakeConversationAgentFactory } from "./backend/fake-conversation-agent.js";
import { ModelPricingService } from "./backend/model-pricing-service.js";
import { ModelService } from "./backend/model-service.js";
import { SessionReportService } from "./backend/session-report-service.js";
import { PiConversationAgentFactory, SdkPiSessionFactory } from "./backend/pi-conversation-agent.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { StructuredLogger } from "./backend/structured-logger.js";
import { ToolAuthorizationBroker } from "./backend/tool-authorization-broker.js";
import { ToolAuditStore } from "./backend/tool-audit-store.js";
import { ToolPolicyStore } from "./backend/tool-policy-store.js";
import { UpdateService } from "./backend/update-service.js";
import { registerAgentHandlers } from "./ipc/register-handlers.js";
import { registerConversationHandlers } from "./ipc/register-conversation-handlers.js";
import { registerModelSettingsHandlers } from "./ipc/register-model-settings-handlers.js";
import { registerSessionReportHandlers } from "./ipc/register-session-report-handlers.js";
import { registerToolPolicyHandlers } from "./ipc/register-tool-policy-handlers.js";
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
  const modelService = await ModelService.create({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    encryption: new SafeStorageEncryption(),
  });
  const logger = new StructuredLogger();
  autoUpdater.channel = app.getVersion().includes("-beta.") ? "beta" : "latest";
  const updateService = new UpdateService(autoUpdater, app.getVersion(), app.isPackaged);
  const unsubscribeUpdateState = updateService.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(WISP_IPC_CHANNELS.updateState, state);
    }
  });
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
        const window =
          BrowserWindow.getFocusedWindow() ??
          BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        return window?.webContents.id ?? null;
      },
      audit: new ToolAuditStore(path.join(app.getPath("userData"), "backend", "tool-audit.jsonl")),
    },
  );
  const agentFactory: ConversationAgentFactory =
    selectAgentMode(app.isPackaged, process.env.WISP_AGENT_MODE) === "fake"
      ? new FakeConversationAgentFactory({ latencyMs: 350 })
      : new PiConversationAgentFactory(
          new SdkPiSessionFactory(modelService.getModelRuntime(), toolAuthorizationBroker),
        );
  agentRegistry = new AgentRegistry(agentFactory, publishAgentEvent, (conversationId) =>
    toolAuthorizationBroker.cancelConversation(conversationId),
  );
  const conversationRepository = new ConversationRepository({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    userName: DEMO_CURRENT_USER.givenName,
  });
  conversationService = new ConversationService(conversationRepository, agentRegistry, () =>
    toolAuthorizationBroker.listPending(),
  );
  await conversationService.start(await modelService.getSelection());
  const sessionReportHandlers = registerSessionReportHandlers(
    ipcMain,
    new SessionReportService(
      conversationRepository,
      new ModelPricingService({
        cacheFilePath: path.join(app.getPath("userData"), "backend", "model-pricing.json"),
      }),
    ),
    isTrustedIpcSender,
  );
  const agentHandlers = registerAgentHandlers(ipcMain, agentRegistry, isTrustedIpcSender);
  const conversationHandlers = registerConversationHandlers(ipcMain, conversationService, isTrustedIpcSender);
  const modelSettingsHandlers = registerModelSettingsHandlers(ipcMain, modelService, isTrustedIpcSender, (selection) =>
    conversationService.applyModel(selection),
  );
  const toolPolicyHandlers = registerToolPolicyHandlers(ipcMain, toolAuthorizationBroker, isTrustedIpcSender);
  const updateHandlers = registerUpdateHandlers(ipcMain, updateService, isTrustedIpcSender);
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    toolPolicyHandlers.dispose();
    updateHandlers.dispose();
    unsubscribeUpdateState();
    toolAuthorizationBroker.dispose();
    modelSettingsHandlers.dispose();
    sessionReportHandlers.dispose();
    conversationHandlers.dispose();
    void agentHandlers.dispose().finally(() => {
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
