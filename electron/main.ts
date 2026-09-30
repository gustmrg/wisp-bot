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

import { WISP_IPC_CHANNELS, WISP_RELEASES_URL, type SequencedConversationAgentEvent } from "../shared/contracts.js";
import { DEMO_CURRENT_USER } from "../shared/current-user.js";
import { selectAgentMode } from "./backend/agent-mode.js";
import { AgentRegistry } from "./backend/agent-registry.js";
import type { ConversationAgentFactory } from "./backend/conversation-agent.js";
import { ConversationRepository } from "./backend/conversation-repository.js";
import { ConversationService } from "./backend/conversation-service.js";
import { FakeConversationAgentFactory } from "./backend/fake-conversation-agent.js";
import { CompositeIntegrationToolSource } from "./backend/integration-tool-source.js";
import { FileLogSink } from "./backend/file-log-sink.js";
import { McpService } from "./backend/mcp-service.js";
import { ModelPricingService } from "./backend/model-pricing-service.js";
import { ModelService } from "./backend/model-service.js";
import { PiConversationAgentFactory, SdkPiSessionFactory } from "./backend/pi-conversation-agent.js";
import { PluginService } from "./backend/plugin-service.js";
import { SafeStorageEncryption } from "./backend/safe-storage-encryption.js";
import { SessionReportService } from "./backend/session-report-service.js";
import { CompositeLogSink, StructuredLogger } from "./backend/structured-logger.js";
import { ToolAuditStore } from "./backend/tool-audit-store.js";
import { ToolAuthorizationBroker } from "./backend/tool-authorization-broker.js";
import { ToolPolicyStore } from "./backend/tool-policy-store.js";
import { resolveAutoInstallSupport } from "./backend/update-capability.js";
import { UpdateService } from "./backend/update-service.js";
import { registerConversationHandlers } from "./ipc/register-conversation-handlers.js";
import { registerAgentHandlers } from "./ipc/register-handlers.js";
import { registerMcpHandlers } from "./ipc/register-mcp-handlers.js";
import { registerModelSettingsHandlers } from "./ipc/register-model-settings-handlers.js";
import { registerPluginHandlers } from "./ipc/register-plugin-handlers.js";
import { registerSessionReportHandlers } from "./ipc/register-session-report-handlers.js";
import { registerToolPolicyHandlers } from "./ipc/register-tool-policy-handlers.js";
import { registerUpdateHandlers } from "./ipc/register-update-handlers.js";
import { WispBackendError } from "./backend/backend-error.js";
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
  const modelService = await ModelService.create({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    encryption: new SafeStorageEncryption(),
  });
  const logger = new StructuredLogger(
    new CompositeLogSink([console, new FileLogSink(path.join(app.getPath("userData"), "backend", "logs"))]),
  );
  autoUpdater.channel = app.getVersion().includes("-beta.") ? "beta" : "latest";
  const autoInstallSupported = app.isPackaged
    ? await resolveAutoInstallSupport(process.platform, process.execPath)
    : false;
  const updateService = new UpdateService(autoUpdater, app.getVersion(), app.isPackaged, autoInstallSupported, logger);
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
  const conversationRepository = new ConversationRepository({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    userName: DEMO_CURRENT_USER.givenName,
  });
  const pluginService = new PluginService({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    encryption: new SafeStorageEncryption(),
    authorizationBroker: toolAuthorizationBroker,
    resolveWisp: (id) => conversationRepository.getAgentContext(id).sessionId,
  });
  await pluginService.load();
  const mcpService = new McpService({
    dataDirectory: path.join(app.getPath("userData"), "backend"),
    encryption: new SafeStorageEncryption(),
    authorizationBroker: toolAuthorizationBroker,
    resolveWisp: (id) => conversationRepository.getAgentContext(id).sessionId,
    openExternal: openExternalUrl,
    // Health updates: push the sanitized view; secrets never leave the backend.
    onSettingsChanged: (view) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(WISP_IPC_CHANNELS.mcpSettingsChanged, view);
      }
    },
  });
  await mcpService.load();
  const integrationTools = new CompositeIntegrationToolSource([pluginService, mcpService]);
  const agentFactory: ConversationAgentFactory =
    selectAgentMode(app.isPackaged, process.env.WISP_AGENT_MODE) === "fake"
      ? new FakeConversationAgentFactory({ latencyMs: 350 })
      : new PiConversationAgentFactory(
          new SdkPiSessionFactory(modelService.getModelRuntime(), toolAuthorizationBroker, integrationTools),
        );
  agentRegistry = new AgentRegistry(
    agentFactory,
    publishAgentEvent,
    (conversationId) => toolAuthorizationBroker.cancelConversation(conversationId),
    { validateModel: (selection) => modelService.validateConversationSelection(selection) },
  );
  conversationService = new ConversationService(
    conversationRepository,
    agentRegistry,
    () => toolAuthorizationBroker.listPending(),
    {
      onChatChanged: (chat) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(WISP_IPC_CHANNELS.conversationChanged, chat);
        }
      },
    },
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
  const agentHandlers = registerAgentHandlers(ipcMain, agentRegistry, isTrustedIpcSender, async (id, model) => {
    if (model) await modelService.validateConversationSelection(model);
    await conversationService.applyConversationModel(id, model);
  });
  const conversationHandlers = registerConversationHandlers(ipcMain, conversationService, isTrustedIpcSender);
  const modelSettingsHandlers = registerModelSettingsHandlers(ipcMain, modelService, isTrustedIpcSender, (selection) =>
    conversationService.applyModel(selection),
  );
  const toolPolicyHandlers = registerToolPolicyHandlers(ipcMain, toolAuthorizationBroker, isTrustedIpcSender);
  const pluginHandlers = registerPluginHandlers(ipcMain, pluginService, isTrustedIpcSender);
  const mcpHandlers = registerMcpHandlers(ipcMain, mcpService, isTrustedIpcSender);
  const updateHandlers = registerUpdateHandlers(ipcMain, updateService, isTrustedIpcSender, async () => {
    await openExternalUrl(WISP_RELEASES_URL);
  });
  let backendDisposed = false;
  let backendDisposing = false;
  app.on("before-quit", (event) => {
    if (backendDisposed) return;
    event.preventDefault();
    if (backendDisposing) return;
    backendDisposing = true;
    toolPolicyHandlers.dispose();
    pluginHandlers.dispose();
    mcpHandlers.dispose();
    pluginService.dispose();
    mcpService.dispose();
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
