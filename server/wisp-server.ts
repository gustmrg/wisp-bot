import { mkdir, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

import { WispBackendError } from "../backend/backend-error.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import type { HandlerRouter } from "../backend/handlers/guarded-handlers.js";
import { registerRuntimeHandlers } from "../backend/handlers/register-runtime-handlers.js";
import { createBackendRuntime, disposeWithin, type BackendRuntime } from "../backend/runtime.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import { startAdminSocket } from "./admin.js";
import { createBackup } from "./backup.js";
import { readPrivateKeyFile } from "./master-key.js";
import { DeviceAuth } from "./device-auth.js";
import { boundedString, HttpError } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { createHttpApi, OWNER_PRINCIPAL_ID, type HttpApi, type OperationListener } from "./http-api.js";
import { InstanceLock } from "./instance-lock.js";
import { ServerStore } from "./server-store.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
// Agents get this long to settle their last turn on shutdown.
const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface WispServerOptions {
  /** Owns `server.sqlite`, the admin socket, and the backend stores under `backend/`. */
  dataDirectory: string;
  /** Loopback unless `allowExternalBind` is set, e.g. inside a container that publishes the port on loopback. */
  host: string;
  port: number;
  allowExternalBind?: boolean;
  /** The exact HTTPS origin a reverse proxy (such as Tailscale Serve) exposes the server at. */
  publicOrigin?: string;
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
    ): Promise<ReadonlyArray<string>> => {
      if (!api) throw new WispBackendError("unavailable", "The server is starting.", true);
      const answer = await api.requestHost(request, timeoutMs, unsupported);
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
      openPath: async (directory) => {
        await askHost(
          { kind: "openPath", path: directory },
          30_000,
          "Folders on the server cannot be opened from this device.",
        );
      },
      // A file picker stays open while the person chooses.
      selectFiles: () =>
        askHost({ kind: "selectFiles" }, 30 * 60_000, "Attaching files to a Wisp on a server is not available yet."),
      onAgentEvent: (event) => hub.publish("agentEvent", event),
      onConversationChanged: (delta) => hub.publish("conversationChanged", delta),
      onMcpSettingsChanged: (view) => hub.publish("mcpSettingsChanged", view),
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
      logger: options.logger,
    });
    const http = createServer({ headersTimeout: 15_000, requestTimeout: 120_000 }, (request, response) =>
      api.handle(request, response),
    );
    await listen(http, options.port, options.host);
    cleanup.push(() => closeServer(http, () => api.closeStreams()));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("The HTTP listener is unavailable.");

    if (options.adminSocket ?? true) {
      const admin = await startAdminSocket(options.dataDirectory, async (command) => {
        switch (command.command) {
          case "pair":
            return auth.createPairingCode();
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
              throw new HttpError(
                400,
                "invalid_request",
                error instanceof Error ? error.message : "The key is invalid.",
              );
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
              throw new HttpError(
                400,
                "invalid_request",
                error instanceof Error ? error.message : "The backup failed.",
              );
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
            };
          default:
            throw new HttpError(400, "invalid_request", "Unknown administrative command.");
        }
      });
      cleanup.push(() => closeServer(admin));
    }

    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      serverId: store.serverId,
      auth,
      runtime,
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
