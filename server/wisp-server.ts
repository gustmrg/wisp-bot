import { mkdir, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { WispBackendError } from "../backend/backend-error.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import type { HandlerRouter } from "../backend/handlers/guarded-handlers.js";
import { registerRuntimeHandlers } from "../backend/handlers/register-runtime-handlers.js";
import { parseConversationRequest } from "../backend/validators.js";
import { createBackendRuntime, disposeWithin, type BackendRuntime } from "../backend/runtime.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import { startAdminSocket, type AdminCommand, type AdminHandler } from "./admin.js";
import { createBackup } from "./backup.js";
import { readPrivateKeyFile } from "./master-key.js";
import { DeviceAuth } from "./device-auth.js";
import { boundedString, HttpError } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { createHttpApi, OWNER_PRINCIPAL_ID, type HttpApi, type OperationListener } from "./http-api.js";
import { InstanceLock } from "./instance-lock.js";
import { openOAuthRelay } from "./oauth-relay.js";
import { ServerStore } from "./server-store.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
// Agents get this long to settle their last turn on shutdown.
const SHUTDOWN_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 120_000;

export interface WispServerOptions {
  /** Owns `server.sqlite`, the admin socket, and the backend stores under `backend/`. */
  dataDirectory: string;
  /** Loopback unless `allowExternalBind` is set, e.g. inside a container that publishes the port on loopback. */
  host: string;
  port: number;
  allowExternalBind?: boolean;
  /** The exact HTTPS origin a reverse proxy (such as Tailscale Serve) exposes the server at. */
  publicOrigin?: string;
  /** The browser app's built files; without them the server answers only the API. */
  webRoot?: string;
  encryption: EncryptionService;
  logger: StructuredLogger;
  agentMode: "pi" | "fake";
  appVersion: string;
  /** Refresh model catalogs over the network after startup. Defaults to true. */
  allowModelNetwork?: boolean;
  /** Serve administrative commands on `<dataDirectory>/admin.sock`. Defaults to true. */
  adminSocket?: boolean;
  /**
   * A pairing code from the desktop app that started this server. The device
   * it pairs is local, so the server can ask it to open folders and pickers.
   */
  localPairingCode?: string;
  /**
   * Refuse a data directory other accounts can read. Defaults to true; the
   * desktop app's own data directory is protected by the operating system.
   */
  requirePrivateDirectory?: boolean;
  now?: () => number;
}

export interface WispServer {
  /** The loopback URL the server listens on. */
  url: string;
  port: number;
  serverId: string;
  auth: DeviceAuth;
  runtime: BackendRuntime;
  /**
   * Runs an administrative command (pair, devices, revoke, status, backup, or
   * expose, which opens a second port for remote access), as the admin socket does.
   */
  admin: AdminHandler;
  /** Stops accepting requests, ends event streams, then lets agents settle before closing storage. */
  close(): Promise<void>;
}

/** Composes a headless server: the shared backend runtime behind authenticated HTTP. */
export async function createWispServer(options: WispServerOptions): Promise<WispServer> {
  if (!LOOPBACK_HOSTS.has(options.host) && !options.allowExternalBind) {
    throw new Error("The server listens on loopback only. Expose it through SSH or a private proxy.");
  }
  const publicOrigin = options.publicOrigin ? parsePublicOrigin(options.publicOrigin) : undefined;
  const requirePrivate = options.requirePrivateDirectory ?? true;
  await preparePrivateDirectory(options.dataDirectory, requirePrivate);
  const backendDirectory = path.join(options.dataDirectory, "backend");
  await preparePrivateDirectory(backendDirectory, requirePrivate);

  const lock = InstanceLock.acquire(options.dataDirectory);
  const cleanup: Array<() => Promise<void> | void> = [() => lock.release()];
  const runCleanup = async (): Promise<void> => {
    for (const step of cleanup.reverse()) await step();
  };
  try {
    const store = new ServerStore(options.dataDirectory);
    cleanup.push(() => store.close());
    const auth = new DeviceAuth(store, options.now);
    if (options.localPairingCode) auth.registerLocalPairingCode(options.localPairingCode);
    const hub = new EventHub();
    // Screen actions go to the desktop app on this computer; the API is
    // created after the runtime, which needs these from the start.
    let api: HttpApi | undefined;
    const askHost = async (
      request: Parameters<HttpApi["requestHost"]>[0],
      timeoutMs: number,
      unsupported: string,
      requestOptions?: Parameters<HttpApi["requestHost"]>[3],
    ): Promise<ReadonlyArray<string>> => {
      if (!api) throw new WispBackendError("unavailable", "The server is starting.", true);
      const answer = await api.requestHost(request, timeoutMs, unsupported, requestOptions);
      if (!answer.ok) throw new WispBackendError("internal_error", answer.message);
      return answer.value ?? [];
    };
    const runtime = await createBackendRuntime({
      dataDirectory: backendDirectory,
      encryption: options.encryption,
      logger: options.logger,
      agentMode: options.agentMode,
      appVersion: options.appVersion,
      ...(options.allowModelNetwork === undefined ? {} : { allowModelNetwork: options.allowModelNetwork }),
      // Pending approvals wait for any paired device, even when none is connected yet.
      selectApprovalWindowId: () => OWNER_PRINCIPAL_ID,
      openExternal: async (url) => {
        await askHost(
          { kind: "openExternal", url },
          30_000,
          "Signing in to an MCP server needs a browser on the server's computer.",
        );
      },
      // A sign-in started from this computer's app uses this computer's browser.
      // The desktop app on another computer receives the redirect on its own
      // loopback; devices that cannot (the browser app, an older app) get a
      // page to open and paste the redirect back from.
      signInBrowser: async () => {
        const device = api?.callerDevice();
        if (!device || device.local) return { kind: "local" };
        try {
          const relay = await openOAuthRelay((request, timeoutMs) =>
            askHost(request, timeoutMs, "This device cannot receive the sign-in.", { device: device.deviceId }),
          );
          return { kind: "relay", relay };
        } catch {
          return { kind: "manual" };
        }
      },
      openPath: async (directory) => {
        await askHost(
          { kind: "openPath", path: directory },
          30_000,
          "Folders on the server cannot be opened from this device.",
        );
      },
      // A file picker stays open while the person chooses. Other devices upload their files instead.
      selectFiles: () =>
        askHost({ kind: "selectFiles" }, 30 * 60_000, "This device sends attached files to the server instead."),
      onAgentEvent: (event) => hub.publish("agentEvent", event),
      onConversationChanged: (delta) => hub.publish("conversationChanged", delta),
      onWispsChanged: (view) => hub.publish("wispsChanged", view),
      onMcpSettingsChanged: (view) => hub.publish("mcpSettingsChanged", view),
      onPluginSettingsChanged: (view) => hub.publish("pluginSettingsChanged", view),
      onScheduledMessagesChanged: (view) => hub.publish("scheduledMessagesChanged", view),
      onMessageQueueChanged: (view) => hub.publish("messageQueueChanged", view),
      onJobsChanged: (view) => hub.publish("jobsChanged", view),
    });
    cleanup.push(async () => {
      const settled = await disposeWithin(() => runtime.dispose(), SHUTDOWN_TIMEOUT_MS);
      if (!settled) options.logger.warn("shutdown_timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    });

    const operations = new Map<string, OperationListener>();
    const router: HandlerRouter = {
      handle: (channel, listener) => void operations.set(channel, listener),
      removeHandler: (channel) => void operations.delete(channel),
    };
    // HTTP authenticates every device before an operation runs.
    registerRuntimeHandlers(router, runtime, () => true);

    const allowedHostNames = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (publicOrigin) allowedHostNames.add(publicOrigin.hostname);
    let backingUp = false;
    api = createHttpApi({
      isPaused: () => backingUp,
      auth,
      hub,
      operations,
      serverId: store.serverId,
      version: options.appVersion,
      allowedHostNames,
      allowedOrigins: new Set(publicOrigin ? [publicOrigin.origin] : []),
      ...(publicOrigin ? { publicOrigin: publicOrigin.origin } : {}),
      ...(options.webRoot ? { webRoot: options.webRoot } : {}),
      uploadWorkspaceFile: ({ conversationId, name, size, content }) =>
        runtime.workspace.receive(parseConversationRequest({ conversationId }).conversationId, { name, size }, content),
      logger: options.logger,
    });
    // No limit on a whole request, so a large upload over a slow link can finish;
    // a connection that sends nothing for two minutes is closed instead.
    const createListener = (): Server => {
      const listener = createServer({ headersTimeout: 15_000, requestTimeout: 0 }, (request, response) =>
        api.handle(request, response),
      );
      listener.setTimeout(IDLE_TIMEOUT_MS);
      return listener;
    };
    const http = createListener();
    await listen(http, options.port, options.host);
    cleanup.push(() => closeServer(http, () => api.closeStreams()));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("The HTTP listener is unavailable.");

    // A second loopback port a private HTTPS proxy forwards to, opened while the
    // desktop app exposes its server for remote access; clients on the first
    // port keep their connections.
    let exposed: { listener: Server; port: number; origin: string; webRoot?: string } | undefined;
    const unexpose = async (): Promise<void> => {
      const current = exposed;
      exposed = undefined;
      if (!current) return;
      api.setPublicAccess(undefined);
      await closeServer(current.listener);
    };
    cleanup.push(unexpose);
    const expose = async (command: AdminCommand): Promise<void> => {
      if (command.publicOrigin === undefined || command.publicOrigin === null) {
        await unexpose();
        return;
      }
      let origin: string;
      try {
        origin = parsePublicOrigin(boundedString(command.publicOrigin, 2048)).origin;
      } catch (error) {
        throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : "The origin is invalid.");
      }
      const port = command.port;
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
        throw new HttpError(400, "invalid_request", "The port must be between 1 and 65535.");
      }
      const webRoot = command.webRoot === undefined ? undefined : boundedString(command.webRoot, 4096);
      if (webRoot !== undefined && !path.isAbsolute(webRoot)) {
        throw new HttpError(400, "invalid_request", "Give the browser app's folder as an absolute path.");
      }
      if (exposed && exposed.port === port && exposed.origin === origin && exposed.webRoot === webRoot) return;
      await unexpose();
      const listener = createListener();
      try {
        await listen(listener, port as number, options.host);
      } catch (error) {
        throw new HttpError(
          409,
          "invalid_request",
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? `Another program already uses port ${port} on this computer. Choose another port.`
            : `Wisp could not listen on port ${port}.`,
        );
      }
      exposed = { listener, port: port as number, origin, ...(webRoot ? { webRoot } : {}) };
      api.setPublicAccess({ publicOrigin: origin, ...(webRoot ? { webRoot } : {}) });
    };

    // Reaching this handler is the authorization: the admin socket, or the
    // stdin of a server the desktop app started, belong to the data's owner.
    const admin: AdminHandler = async (command) => {
      switch (command.command) {
        case "pair":
          return auth.createPairingCode();
        case "expose":
          await expose(command);
          return {};
        case "devices":
          return auth.devices();
        case "revoke": {
          if (!auth.revoke(boundedString(command.deviceId, 64))) {
            throw new HttpError(404, "not_found", "No paired device has that ID.");
          }
          return {};
        }
        case "backup": {
          const output = boundedString(command.output, 4096);
          if (!path.isAbsolute(output))
            throw new HttpError(400, "invalid_request", "Give the backup file as an absolute path.");
          if (backingUp) throw new HttpError(409, "invalid_request", "A backup is already being written.");
          const working = Object.values(runtime.registry.statuses()).filter((status) => status === "working").length;
          if (working > 0) {
            throw new HttpError(
              409,
              "invalid_request",
              `${working} Wisp${working === 1 ? " is" : "s are"} working. Back up when they finish.`,
            );
          }
          let key: Buffer;
          try {
            key = readPrivateKeyFile(boundedString(command.keyFile, 4096));
          } catch (error) {
            throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : "The key is invalid.");
          }
          backingUp = true;
          try {
            return await createBackup({
              dataDirectory: options.dataDirectory,
              output,
              key,
              appVersion: options.appVersion,
            });
          } catch (error) {
            throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : "The backup failed.");
          } finally {
            backingUp = false;
          }
        }
        case "status":
          return {
            serverId: store.serverId,
            bootId: hub.bootId,
            version: options.appVersion,
            port: address.port,
            devices: auth.devices().length,
            // Whether the browser app answers at the public origin, so a pairing link opens it.
            web: Boolean(exposed?.webRoot ?? options.webRoot),
            ...(exposed
              ? { publicOrigin: exposed.origin, exposedPort: exposed.port }
              : publicOrigin
                ? { publicOrigin: publicOrigin.origin }
                : {}),
          };
        default:
          throw new HttpError(400, "invalid_request", "Unknown administrative command.");
      }
    };
    if (options.adminSocket ?? true) {
      const socket = await startAdminSocket(options.dataDirectory, admin);
      cleanup.push(() => closeServer(socket));
    }

    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      serverId: store.serverId,
      auth,
      runtime,
      admin,
      close: () => {
        closing ??= runCleanup();
        return closing;
      },
    };
  } catch (error) {
    await runCleanup();
    throw error;
  }
}

function parsePublicOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error("The public origin must be an exact HTTPS origin, such as https://wisp.example.ts.net.");
  }
  return url;
}

/** Creates the directory owner-only, and optionally refuses one that other accounts can read. */
async function preparePrivateDirectory(directory: string, requirePrivate: boolean): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`${directory} is not a directory.`);
  if (requirePrivate && (info.mode & 0o077) !== 0) {
    throw new Error(`${directory} must be a directory only its owner can access (chmod 700).`);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server, beforeClose?: () => void): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    beforeClose?.();
    server.closeAllConnections();
  });
}
