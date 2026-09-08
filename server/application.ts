import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createBackend, type BackendRuntime } from "../backend/bootstrap.js";
import { WispBackendError } from "../backend/backend-error.js";
import { ToolAuthorizationBroker } from "../backend/tool-authorization-broker.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import type { BackendResult, SequencedConversationAgentEvent } from "../shared/contracts.js";
import * as validators from "../shared/validators.js";
import { DeviceAuth, type DeviceCredentials, type DevicePrincipal } from "./auth/device-auth.js";
import { ServerDatabase } from "./storage/database.js";
import { SqliteConversationRepository } from "./storage/conversation-repository.js";
import { SqliteToolPolicy } from "./storage/tool-policy.js";
import { SqliteAiSettings } from "./storage/ai-settings.js";
import { MasterKeyEncryption } from "./encryption/master-key.js";
import { DurableExecutor } from "./executor.js";
import { HttpError, boundedString } from "./errors.js";
import { checkCsrf, checkOrigin, cookies, jsonBody } from "./http/security.js";
import { eventStream } from "./http/event-stream.js";
import { startAdminSocket, type AdminOperation } from "./admin.js";
import {
  exportServerBackup,
  exportServerMigration,
  importMigration,
  readTransferKey,
  recoverInterruptedImport,
} from "./transfer/archive.js";

export interface WispServerOptions {
  dataDirectory: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  allowedOrigins?: string[];
  allowExternalBind?: boolean;
  ownerName?: string;
  timeZone?: string;
  agentMode?: "pi" | "fake";
  fakeLatencyMs?: number;
  masterKeyFile?: string;
  previousMasterKeyFile?: string;
  encryption?: EncryptionService;
  webRoot?: string;
  admin?: boolean;
  adminOperation?: AdminOperation;
}
export interface WispServer {
  database: ServerDatabase;
  repository: SqliteConversationRepository;
  backend: BackendRuntime;
  executor: DurableExecutor;
  auth: DeviceAuth;
  url: string;
  close(): Promise<void>;
}

export async function createWispServer(options: WispServerOptions): Promise<WispServer> {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host) && !options.allowExternalBind)
    throw new Error("Bind must be loopback unless explicitly enabled for a contained deployment.");
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin);
    if (
      url.origin !== options.publicOrigin ||
      (!["https:"].includes(url.protocol) &&
        !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    )
      throw new Error("WISP_PUBLIC_ORIGIN must be an HTTPS origin or a loopback development origin.");
  }
  const database = new ServerDatabase(options.dataDirectory);
  let backend: BackendRuntime | undefined;
  let http: Server | undefined;
  let admin: Server | undefined;
  try {
    recoverInterruptedImport(database);
    const ownerName = database.getMeta("ownerName") ?? options.ownerName ?? "Owner";
    database.setMeta("ownerName", ownerName);
    const timeZone = database.getMeta("timeZone") ?? options.timeZone ?? "UTC";
    new Intl.DateTimeFormat("en", { timeZone }).format();
    if (options.timeZone && options.timeZone !== timeZone)
      throw new Error("The instance timezone is already configured. Migrate it explicitly.");
    database.setMeta("timeZone", timeZone);
    process.env.TZ = timeZone;
    const repository = new SqliteConversationRepository(database, ownerName);
    const auth = new DeviceAuth(database);
    const policy = new SqliteToolPolicy(database);
    let resolvingDevice: string | undefined;
    const authorization = new ToolAuthorizationBroker(
      policy,
      (event) => backend?.registry.publishExternalEvent(event),
      {
        selectPrincipal: () => database.ownerId,
        persistRequest: (request) =>
          database.transaction(() => {
            database.sql
              .prepare("INSERT INTO approvals(id,request,state) VALUES (?,?,'pending')")
              .run(request.approvalId, JSON.stringify(request));
          }),
        commitDecision: (request, pending, principal) =>
          database.transaction(() => {
            if (principal !== database.ownerId || !resolvingDevice)
              throw new HttpError(403, "forbidden", "An authenticated device must resolve this approval.");
            const claimed = database.sql
              .prepare(
                "UPDATE approvals SET state=?,device_id=?,decided_at=? WHERE id=? AND state='pending' RETURNING id",
              )
              .get(request.decision, resolvingDevice, new Date().toISOString(), request.approvalId);
            if (!claimed) throw new HttpError(409, "conflict", "This approval was already resolved.");
            if (request.decision === "block") policy.blockSync(pending.category, randomUUID);
            database.sql.prepare("INSERT INTO audit(record) VALUES (?)").run(
              JSON.stringify({
                approvalId: request.approvalId,
                deviceId: resolvingDevice,
                decision: request.decision,
                occurredAt: new Date().toISOString(),
              }),
            );
          }),
      },
    );
    let executor: DurableExecutor | undefined;
    const startupEvents: SequencedConversationAgentEvent[] = [];
    backend = await createBackend({
      dataDirectory: options.dataDirectory,
      encryption:
        options.encryption ?? MasterKeyEncryption.fromFile(options.masterKeyFile, options.previousMasterKeyFile),
      userName: ownerName,
      repository,
      manageAgentPersistence: false,
      aiSettings: new SqliteAiSettings(database),
      authorizationBroker: authorization,
      agentMode: options.agentMode ?? "pi",
      fakeLatencyMs: options.fakeLatencyMs,
      publishEvent: (event) => {
        if (executor) executor.handleEvent(event);
        else startupEvents.push(event);
      },
    });
    executor = new DurableExecutor(database, repository, backend.registry);
    const runtime = backend;
    const runner = executor;
    runner.recover();
    for (const event of startupEvents) runner.handleEvent(event);
    let ready = true,
      maintaining = false,
      closing: Promise<void> | undefined;
    let mutation = Promise.resolve();
    const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = mutation.then(operation, operation);
      mutation = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const settingsRevision = (): number => Number(database.getMeta("settingsRevision") ?? 0);
    const expectSettings = (value: unknown): void => {
      if (!Number.isSafeInteger(value) || value !== settingsRevision())
        throw new HttpError(409, "conflict", "The settings changed. Reload them before editing.");
    };
    const settingsChanged = (): void => {
      database.transaction(() => {
        database.setMeta("settingsRevision", String(settingsRevision() + 1));
        database.appendEvent("settings_changed", { settingsRevision: settingsRevision() });
      });
    };
    const descriptor = () => ({
      protocolVersion: 1,
      serverId: database.serverId,
      bootId: database.bootId,
      owner: { id: database.ownerId, name: ownerName },
      version: "0.1.0",
      capabilities: [
        "durable-requests",
        "sse-replay",
        "device-auth",
        "shared-approvals",
        "ssh",
        "tailscale-serve",
        "web-session",
      ],
      limits: { maxPendingPerConversation: 8, maxRunning: 4, maxMessageBytes: 131072 },
      timeZone,
    });
    const snapshot = () =>
      database.transaction(() => ({
        serverId: database.serverId,
        bootId: database.bootId,
        cursor: database.cursor(),
        revision: Number(database.cursor().split(":")[1]),
        state: runtime.conversations.getState(),
        revisions: repository.revisions(),
        settingsRevision: settingsRevision(),
        requests: database.sql
          .prepare(
            "SELECT conversation_id AS conversationId,id AS requestId,status,revision FROM requests WHERE status IN ('queued','running') ORDER BY ordinal LIMIT 8000",
          )
          .all(),
      }));
    const allowedHosts = new Set<string>();
    if (options.publicOrigin) allowedHosts.add(new URL(options.publicOrigin).host.toLowerCase());
    const streams = new Set<() => void>();
    const send = (response: ServerResponse, value: unknown, status = 200): void => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify({ ok: true, value }));
    };
    const unwrap = <T>(result: BackendResult<T>): T => {
      if (!result.ok) throw new WispBackendError(result.error.code, result.error.message, result.error.retryable);
      return result.value;
    };
    const cookieSecure = options.publicOrigin?.startsWith("https:") ?? false;
    const setCookies = (response: ServerResponse, credentials?: DeviceCredentials): void => {
      const suffix = `; HttpOnly; SameSite=Strict${cookieSecure ? "; Secure" : ""}`;
      response.setHeader("Set-Cookie", [
        `wisp_access=${credentials?.accessToken ?? ""}; Path=/api/v1; Max-Age=${credentials ? 900 : 0}${suffix}`,
        `wisp_refresh=${credentials?.refreshToken ?? ""}; Path=/api/v1/auth; Max-Age=${credentials ? 2592000 : 0}${suffix}`,
      ]);
    };
    const sessionView = (credentials: DeviceCredentials) => ({
      deviceId: credentials.deviceId,
      serverId: credentials.serverId,
      expiresAt: credentials.expiresAt,
      csrfToken: credentials.csrfToken,
    });
    const authenticate = (request: IncomingMessage): { principal: DevicePrincipal; cookie: boolean } => {
      const authorization = request.headers.authorization;
      if (authorization) {
        if (!authorization.startsWith("Bearer "))
          throw new HttpError(401, "unauthorized", "Use a paired device session.");
        return { principal: auth.authenticate(authorization.slice(7)), cookie: false };
      }
      const token = cookies(request).wisp_access;
      if (!token) throw new HttpError(401, "unauthorized", "Pair this device to access the server.");
      return { principal: auth.authenticate(token), cookie: true };
    };
    http = createServer(
      { maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 },
      (request, response) => {
        void (async () => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          const url = new URL(request.url ?? "/", "http://localhost");
          checkOrigin(request, response, {
            publicOrigin: options.publicOrigin,
            allowedOrigins: options.allowedOrigins,
            allowedHosts,
          });
          if (request.method === "OPTIONS") {
            response.writeHead(204, {
              "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Wisp-CSRF",
              "Access-Control-Max-Age": "600",
            });
            response.end();
            return;
          }
          if (request.method === "GET" && ["/health/live", "/health/ready"].includes(pathname)) {
            send(
              response,
              { status: pathname.endsWith("live") || ready ? "ok" : "starting" },
              pathname.endsWith("ready") && !ready ? 503 : 200,
            );
            return;
          }
          if (!pathname.startsWith("/api/")) {
            if (options.webRoot && request.method === "GET") {
              await serveWeb(response, options.webRoot, pathname);
              return;
            }
            throw new HttpError(404, "not_found", "The route was not found.");
          }
          if (!pathname.startsWith("/api/v1/"))
            throw new HttpError(409, "incompatible_version", "This server supports API version 1.");
          const route = pathname.slice("/api/v1".length);
          const foreignOrigin = Boolean(
            request.headers.origin &&
              request.headers.origin !== (options.publicOrigin ?? `http://${request.headers.host}`),
          );
          if (foreignOrigin && request.headers.cookie)
            throw new HttpError(403, "forbidden", "Native origins must use a bearer device session.");
          if (route === "/auth/pair" && request.method === "POST") {
            const body = await jsonBody(request);
            if (body.mode !== undefined && body.mode !== "web" && body.mode !== "token")
              throw new HttpError(400, "invalid_request", "The session mode is invalid.");
            if (body.mode === "web" && (!request.headers.origin || foreignOrigin))
              throw new HttpError(403, "forbidden", "Web pairing requires the application origin.");
            const credentials = auth.pair(
              boundedString(body.code, 256),
              boundedString(body.deviceName, 128),
              request.socket.remoteAddress ?? "unknown",
            );
            if (body.mode === "web") {
              setCookies(response, credentials);
              send(response, sessionView(credentials));
            } else send(response, credentials);
            return;
          }
          if (route === "/auth/refresh" && request.method === "POST") {
            const body = await jsonBody(request);
            const cookieToken = cookies(request).wisp_refresh;
            const token = body.refreshToken === undefined ? cookieToken : boundedString(body.refreshToken, 256);
            if (!token) throw new HttpError(401, "unauthorized", "Pair this device to access the server.");
            if (body.refreshToken === undefined) {
              if (foreignOrigin)
                throw new HttpError(403, "forbidden", "Native origins must use a bearer device session.");
              checkCsrf(request, auth.authenticateRefresh(token).csrfToken);
            }
            const credentials = auth.refresh(token);
            if (body.refreshToken === undefined) {
              setCookies(response, credentials);
              send(response, sessionView(credentials));
            } else send(response, credentials);
            return;
          }
          if (route === "/auth/session" && request.method === "GET") {
            const token = cookies(request).wisp_refresh;
            const principal = token ? auth.authenticateRefresh(token) : authenticate(request).principal;
            send(response, { ...principal, serverId: database.serverId });
            return;
          }
          const { principal, cookie } = authenticate(request);
          if (cookie && !["GET", "HEAD"].includes(request.method ?? "")) checkCsrf(request, principal.csrfToken);
          if (route === "/events" && request.method === "GET") {
            if (streams.size >= 128) throw new HttpError(429, "capacity_exceeded", "Too many event streams.");
            const close = eventStream(
              response,
              database,
              auth,
              principal,
              url.searchParams.get("after") ?? database.cursor(),
            );
            streams.add(close);
            response.once("close", () => streams.delete(close));
            return;
          }
          if (route === "/server" && request.method === "GET") {
            send(response, descriptor());
            return;
          }
          if (route === "/snapshot" && request.method === "GET") {
            send(response, snapshot());
            return;
          }
          if (route === "/devices" && request.method === "GET") {
            send(response, auth.devices());
            return;
          }
          if (route.startsWith("/devices/") && request.method === "DELETE") {
            auth.revoke(
              validators.parseConversationRequest({ conversationId: decodeURIComponent(route.slice(9)) })
                .conversationId,
            );
            send(response, {});
            return;
          }
          if (route === "/auth/logout" && request.method === "POST") {
            auth.revoke(principal.deviceId);
            setCookies(response);
            send(response, {});
            return;
          }
          if (request.method === "GET") {
            if (route === "/conversations") {
              send(response, runtime.conversations.getState());
              return;
            }
            if (route === "/settings/ai") {
              const revision = settingsRevision();
              send(response, { ...unwrap(await runtime.api.getAiSettings()), revision });
              return;
            }
            if (route === "/tool-policy") {
              send(response, { ...policy.get(), revision: settingsRevision() });
              return;
            }
            if (route === "/usage") {
              send(
                response,
                await runtime.reports.getUsageReport(
                  validators.parseUsageReportRequest({ period: url.searchParams.get("period") }),
                ),
              );
              return;
            }
          }
          const parts = route.split("/").filter(Boolean).map(decodeURIComponent);
          let conversationId: string | undefined;
          if (parts[0] === "conversations" && parts[1])
            conversationId = validators.parseConversationRequest({ conversationId: parts[1] }).conversationId;
          if (conversationId && request.method === "GET") {
            if (parts.length === 3 && parts[2] === "messages") {
              const before = url.searchParams.get("before") ?? undefined;
              const limit = Number(url.searchParams.get("limit") ?? 200);
              if ((before && !/^\d{1,19}$/.test(before)) || !Number.isInteger(limit) || limit < 1 || limit > 200)
                throw new HttpError(400, "invalid_request", "The message cursor or limit is invalid.");
              send(response, repository.messages(conversationId, before, limit));
              return;
            }
            if (parts.length === 4 && parts[2] === "requests") {
              send(
                response,
                runner.request(
                  conversationId,
                  validators.parseConversationRequest({ conversationId: parts[3] }).conversationId,
                ),
              );
              return;
            }
            if (parts.length === 3 && parts[2] === "model") {
              send(response, {
                ...runtime.conversations.getConversationModel(conversationId),
                revision: repository.revision(conversationId),
              });
              return;
            }
            if (parts.length === 3 && parts[2] === "session-report") {
              send(response, await runtime.reports.getSessionReport(conversationId));
              return;
            }
          }
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method ?? ""))
            throw new HttpError(404, "not_found", "The route was not found.");
          const body = await jsonBody(request);
          await serialized(async () => {
            authenticate(request); // Admission rechecks revocation after waiting for another mutation.
            if (maintaining) throw new HttpError(503, "unavailable", "The server is in maintenance.", true);
            if (!ready) throw new HttpError(503, "unavailable", "The server is shutting down.");
            if (route === "/conversations" && request.method === "POST") {
              send(
                response,
                await runtime.conversations.create(validators.parseCreateConversationRequest(body).conversation),
                201,
              );
              return;
            }
            if (route === "/settings/ai" && request.method === "PUT") {
              expectSettings(body.expectedRevision);
              const value = unwrap(await runtime.api.saveAiSettings(validators.parseSaveAiSettingsRequest(body)));
              send(response, { ...value, revision: settingsRevision() });
              return;
            }
            if (
              parts.length === 4 &&
              parts[0] === "settings" &&
              parts[1] === "ai" &&
              parts[2] === "credentials" &&
              request.method === "DELETE"
            ) {
              expectSettings(body.expectedRevision);
              const value = unwrap(
                await runtime.api.removeProviderCredential(
                  validators.parseRemoveProviderCredentialRequest({ providerId: parts[3] }),
                ),
              );
              settingsChanged();
              send(response, { ...value, revision: settingsRevision() });
              return;
            }
            if (route === "/tool-policy" && request.method === "PUT") {
              expectSettings(body.expectedRevision);
              const value = policy.saveSync(body.settings);
              send(response, { ...value, revision: settingsRevision() });
              return;
            }
            if (parts.length === 3 && parts[0] === "approvals" && parts[2] === "resolve" && request.method === "POST") {
              const approval = validators.parseResolveToolApprovalRequest({ ...body, approvalId: parts[1] });
              resolvingDevice = principal.deviceId;
              try {
                await authorization.resolve(approval, principal.ownerId);
              } finally {
                resolvingDevice = undefined;
              }
              send(response, {});
              return;
            }
            if (conversationId) {
              if (parts.length === 2 && request.method === "PATCH") {
                runner.assertIdle(conversationId);
                repository.expectRevision(conversationId, body.expectedRevision);
                send(
                  response,
                  await runtime.conversations.update(
                    conversationId,
                    validators.parseUpdateConversationRequest({ ...body, conversationId }).changes,
                  ),
                );
                return;
              }
              if (parts.length === 2 && request.method === "DELETE") {
                runner.assertIdle(conversationId);
                repository.expectRevision(conversationId, body.expectedRevision);
                send(response, await runtime.conversations.delete(conversationId));
                return;
              }
              if (parts.length === 3 && parts[2] === "messages" && request.method === "POST") {
                send(response, runner.admit(validators.parseSendMessageRequest({ ...body, conversationId })), 202);
                return;
              }
              if (parts.length === 3 && parts[2] === "abort" && request.method === "POST") {
                await runner.abort(conversationId);
                send(response, {});
                return;
              }
              if (parts.length === 3 && parts[2] === "start" && request.method === "POST") {
                runtime.registry.get(conversationId);
                send(response, {});
                return;
              }
              if (parts.length === 3 && parts[2] === "read" && request.method === "POST") {
                send(response, await runtime.conversations.markRead(conversationId));
                return;
              }
              if (parts.length === 5 && parts[2] === "prompts" && parts[4] === "answer" && request.method === "POST") {
                const prompt = validators.parseAnswerConversationPromptRequest({
                  ...body,
                  conversationId,
                  messageId: parts[3],
                });
                send(
                  response,
                  await runtime.conversations.answerPrompt(conversationId, prompt.messageId, prompt.answer),
                );
                return;
              }
              if (parts.length === 3 && parts[2] === "model" && request.method === "PUT") {
                runner.assertIdle(conversationId);
                repository.expectRevision(conversationId, body.expectedRevision);
                send(
                  response,
                  unwrap(await runtime.api.applyModel(validators.parseApplyModelRequest({ ...body, conversationId }))),
                );
                return;
              }
              if (parts.length === 3 && parts[2] === "context" && request.method === "POST") {
                const context = validators.parseContextRequest({ conversationId, command: body.command });
                if (context.command.action !== "get") {
                  runner.assertIdle(conversationId);
                  repository.expectRevision(conversationId, body.expectedRevision);
                }
                const revision = repository.revision(conversationId);
                const result = await runtime.registry.manageContext(context);
                if (context.command.action !== "get")
                  database.transaction(() => {
                    repository.touch(conversationId!);
                    database.appendEvent("state_changed", { conversationId });
                  });
                send(response, {
                  ...result,
                  revision: context.command.action === "get" ? revision : repository.revision(conversationId),
                });
                return;
              }
            }
            throw new HttpError(404, "not_found", "The route was not found.");
          });
        })().catch((error) => {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          const status =
            error instanceof HttpError
              ? error.status
              : error instanceof WispBackendError
                ? error.code === "not_found"
                  ? 404
                  : error.code === "already_exists"
                    ? 409
                    : error.code === "configuration_required"
                      ? 409
                      : 400
                : 500;
          const safe =
            error instanceof HttpError || error instanceof WispBackendError
              ? { code: error.code, message: error.message, retryable: error.retryable }
              : { code: "internal_error", message: "The server could not complete this operation.", retryable: false };
          response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ ok: false, error: safe }));
        });
      },
    );
    const listener = http;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(options.port ?? 8787, host, () => resolve());
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("The HTTP listener is unavailable.");
    for (const hostname of [host, "127.0.0.1", "localhost", "[::1]"])
      allowedHosts.add(`${hostname}:${address.port}`.toLowerCase());
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
    if (options.admin !== false)
      admin = await startAdminSocket(options.dataDirectory, auth, async (command) => {
        if (command.command === "status") return { ...descriptor(), pendingRequests: runner.pending(), ready };
        if (command.command === "rotate-key") {
          await runtime.models.rotateCredentialEncryption();
          return { rotated: true };
        }
        if (["backup", "export", "import"].includes(String(command.command))) {
          if (maintaining) throw new HttpError(409, "conflict", "Another administrative operation is in progress.");
          maintaining = true;
          runner.setMaintenance(true);
          try {
            await runner.quiesce();
            await mutation;
            const key = readTransferKey(boundedString(command.keyFile, 4096));
            const transferOptions = { dryRun: command.dryRun === true };
            if (command.command === "backup")
              return exportServerBackup(database, boundedString(command.outputFile, 4096), key, transferOptions);
            if (command.command === "export")
              return exportServerMigration(database, boundedString(command.outputFile, 4096), key, transferOptions);
            const result = importMigration(
              database,
              repository,
              boundedString(command.inputFile, 4096),
              key,
              transferOptions,
            );
            if (!transferOptions.dryRun) {
              await runtime.conversations.start(
                options.agentMode === "fake"
                  ? { providerId: "fake", modelId: "deterministic" }
                  : await runtime.models.getSelection(),
              );
              database.appendEvent("state_changed", {});
            }
            return result;
          } finally {
            maintaining = false;
            runner.setMaintenance(false);
          }
        }
        if (options.adminOperation) return options.adminOperation(command);
        throw new HttpError(400, "invalid_request", "Unknown administrative operation.");
      });
    const retention = setInterval(() => database.retainEvents(), 60_000);
    retention.unref();
    return {
      database,
      repository,
      backend: runtime,
      executor: runner,
      auth,
      url,
      close() {
        closing ??= (async () => {
          ready = false;
          clearInterval(retention);
          for (const close of streams) close();
          await runner.shutdown();
          await mutation;
          await runtime.dispose();
          await Promise.all([closeServer(listener), ...(admin ? [closeServer(admin)] : [])]);
          database.checkpoint();
          database.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    if (admin) await closeServer(admin);
    if (http) await closeServer(http);
    if (backend) await backend.dispose();
    database.close();
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
async function serveWeb(response: ServerResponse, root: string, pathname: string): Promise<void> {
  const base = await realpath(root);
  let candidate = path.resolve(base, `.${decodeURIComponent(pathname)}`);
  if (path.relative(base, candidate).startsWith("..") || candidate === base) candidate = path.join(base, "index.html");
  try {
    if (!(await stat(candidate)).isFile()) candidate = path.join(base, "index.html");
  } catch {
    candidate = path.join(base, "index.html");
  }
  const resolved = await realpath(candidate);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new HttpError(403, "forbidden", "The asset path is invalid.");
  const extensions: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };
  response.writeHead(200, {
    "Content-Type": extensions[path.extname(resolved)] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": path.extname(resolved) === ".html" ? "no-cache" : "public, max-age=3600",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  response.end(await readFile(resolved));
}
