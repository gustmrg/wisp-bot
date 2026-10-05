import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { WispBackendError } from "../backend/backend-error.js";

import type { BackendResult } from "../shared/contracts.js";
import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import { encodeRemoteJson } from "../shared/remote-codec.js";
import {
  REMOTE_API_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type RemoteEventType,
  type ServerDescriptor,
} from "../shared/remote-protocol.js";
import type { HandlerEvent } from "../backend/handlers/guarded-handlers.js";
import type { StructuredLogger } from "../backend/structured-logger.js";
import type { DeviceAuth } from "./device-auth.js";
import { boundedString, HttpError, invalidRequest, unauthorized } from "./errors.js";
import type { EventHub, HubEvent } from "./event-hub.js";
import { readJsonBody, sendError, sendJson } from "./http-util.js";

/** Every authenticated device acts for the single owner, so approvals are shared between them. */
export const OWNER_PRINCIPAL_ID = 1;
const OWNER_EVENT: HandlerEvent = { sender: { id: OWNER_PRINCIPAL_ID } };

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
// Base64 of the largest accepted recording (25 MiB) plus the JSON around it.
const AUDIO_BODY_LIMIT = 36 * 1024 * 1024;
const MAX_EVENT_STREAMS = 64;
const HEARTBEAT_MS = 20_000;
// A client this far behind is dropped; it reconnects and replays or resyncs.
const MAX_STREAM_BACKLOG_BYTES = 8 * 1024 * 1024;

const PUSH_OPERATIONS = new Set(["agentEvent", "conversationChanged", "mcpSettingsChanged", "updateState"]);

export type OperationListener = (event: HandlerEvent, payload: unknown) => Promise<BackendResult<unknown>>;

export interface HttpApiOptions {
  auth: DeviceAuth;
  hub: EventHub;
  /** Runtime operations by IPC channel. */
  operations: ReadonlyMap<string, OperationListener>;
  serverId: string;
  version: string;
  /**
   * Host names the Host header may carry, on any port: a tunnel or container
   * can forward a different port. Any other name is refused, which blocks DNS
   * rebinding.
   */
  allowedHostNames: ReadonlySet<string>;
  /** Browser origins allowed to call the API; requests from any other origin are refused. */
  allowedOrigins: ReadonlySet<string>;
  logger: Pick<StructuredLogger, "warn">;
  /** While true (a backup is being written), operations wait for the client to retry. */
  isPaused?: () => boolean;
}

export interface HttpApi {
  handle(request: IncomingMessage, response: ServerResponse): void;
  /**
   * Asks the device behind the current operation to do something on its
   * screen. Only a local device can: on another computer, a server path or a
   * loopback sign-in callback means nothing.
   */
  requestHost(
    request: DistributiveOmit<HostRequest, "id">,
    timeoutMs: number,
    unsupported: string,
  ): Promise<HostResponse>;
  /** Ends every open event stream, e.g. on shutdown. */
  closeStreams(): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** The device whose operation is running, so host requests reach the right screen. */
const caller = new AsyncLocalStorage<{ deviceId: string }>();

export function createHttpApi(options: HttpApiOptions): HttpApi {
  const { auth, hub, logger } = options;
  const streams = new Map<ServerResponse, string>();
  const hostRequests = new Map<string, { deviceId: string; resolve: (response: HostResponse) => void }>();
  const channelsByOperation = new Map<string, string>();
  for (const [operation, channel] of Object.entries(WISP_IPC_CHANNELS)) {
    if (!PUSH_OPERATIONS.has(operation) && options.operations.has(channel)) {
      channelsByOperation.set(operation, channel);
    }
  }
  const descriptor: ServerDescriptor = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    serverId: options.serverId,
    bootId: hub.bootId,
    version: options.version,
    operations: [...channelsByOperation.keys()].sort(),
  };
  auth.onRevoke((deviceId) => {
    for (const [response, owner] of streams) if (owner === deviceId) response.end();
  });

  const authenticate = (request: IncomingMessage): string => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized();
    return auth.authenticate(header.slice("Bearer ".length));
  };

  const checkCaller = (request: IncomingMessage): void => {
    if (!options.allowedHostNames.has(hostNameOf(request.headers.host))) {
      throw new HttpError(403, "forbidden", "This host name is not served here.");
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.has(origin)) {
      throw new HttpError(403, "forbidden", "This origin may not call the Wisp server.");
    }
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    checkCaller(request);
    const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    if (pathname === "/health" && method === "GET") {
      sendJson(response, 200, { ok: true, value: { status: "ok" } });
      return;
    }
    if (!pathname.startsWith(`${REMOTE_API_PREFIX}/`)) throw new HttpError(404, "not_found", "Not found.");
    const path = pathname.slice(REMOTE_API_PREFIX.length);

    if (path === "/auth/pair" && method === "POST") {
      const body = asRecord(await readJsonBody(request, DEFAULT_BODY_LIMIT));
      const credentials = auth.pair(boundedString(body.code, 64), boundedString(body.deviceName, 128));
      sendJson(response, 200, { ok: true, value: credentials });
      return;
    }
    if (path === "/auth/refresh" && method === "POST") {
      const body = asRecord(await readJsonBody(request, DEFAULT_BODY_LIMIT));
      sendJson(response, 200, { ok: true, value: auth.refresh(boundedString(body.refreshToken, 128)) });
      return;
    }

    const deviceId = authenticate(request);
    if (path === "/server" && method === "GET") {
      sendJson(response, 200, { ok: true, value: descriptor });
      return;
    }
    if (path === "/auth/logout" && method === "POST") {
      auth.revoke(deviceId);
      sendJson(response, 200, { ok: true, value: {} });
      return;
    }
    if (path === "/events" && method === "GET") {
      const lastEventId = request.headers["last-event-id"];
      const cursor = (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ?? searchParams.get("after");
      openEventStream(request, response, deviceId, cursor ?? undefined);
      return;
    }
    if (path.startsWith("/rpc/") && method === "POST") {
      if (options.isPaused?.()) {
        throw new HttpError(503, "unavailable", "The server is writing a backup. Try again in a moment.", true);
      }
      const operation = path.slice("/rpc/".length);
      const channel = channelsByOperation.get(operation);
      const listener = channel ? options.operations.get(channel) : undefined;
      if (!listener) throw new HttpError(404, "not_found", "This server does not offer that operation.");
      const limit = operation === "transcribeAudio" ? AUDIO_BODY_LIMIT : DEFAULT_BODY_LIMIT;
      const payload = await readJsonBody(request, limit);
      sendJson(response, 200, await caller.run({ deviceId }, () => listener(OWNER_EVENT, payload)));
      return;
    }
    if (path.startsWith("/host-requests/") && method === "POST") {
      const id = path.slice("/host-requests/".length);
      const pending = hostRequests.get(id);
      // Only the device that was asked may answer.
      if (!pending || pending.deviceId !== deviceId) throw new HttpError(404, "not_found", "No such host request.");
      const body = asRecord(await readJsonBody(request, DEFAULT_BODY_LIMIT));
      hostRequests.delete(id);
      pending.resolve(parseHostResponse(body));
      sendJson(response, 200, { ok: true, value: {} });
      return;
    }
    throw new HttpError(404, "not_found", "Not found.");
  };

  const openEventStream = (
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
    cursor: string | undefined,
  ): void => {
    if (streams.size >= MAX_EVENT_STREAMS) {
      throw new HttpError(503, "unavailable", "Too many event streams are open.", true);
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
    });
    const write = (text: string): void => {
      if (response.writableEnded) return;
      response.write(text);
      if (response.writableLength > MAX_STREAM_BACKLOG_BYTES) response.destroy();
    };
    const writeEvent = (event: HubEvent): void =>
      write(`id: ${event.id}\nevent: ${event.type}\ndata: ${encodeRemoteJson(event.payload)}\n\n`);
    const writeResync = (): void => {
      const type: RemoteEventType = "resync";
      // Carries the current cursor so the client resumes from here after reloading.
      write(`id: ${hub.cursor}\nevent: ${type}\ndata: {}\n\n`);
    };
    // The stream is authorized once; only revocation ends it. Access token
    // expiry does not: the client refreshes for its next request instead.
    streams.set(response, deviceId);
    const subscription = hub.subscribe(cursor, writeEvent);
    write("retry: 2000\n\n");
    if (subscription.resync) writeResync();
    for (const event of subscription.replay) writeEvent(event);
    const heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
      streams.delete(response);
    };
    response.once("close", cleanup);
    request.once("close", cleanup);
  };

  return {
    async requestHost(request, timeoutMs, unsupported) {
      const deviceId = caller.getStore()?.deviceId;
      if (!deviceId || !auth.isLocal(deviceId)) throw new WispBackendError("unsupported", unsupported);
      const targets = [...streams].filter(([, owner]) => owner === deviceId).map(([response]) => response);
      if (targets.length === 0) {
        throw new WispBackendError("unavailable", "Wisp is not connected to the app on this computer.", true);
      }
      const id = randomUUID();
      const answer = new Promise<HostResponse>((resolve) => {
        hostRequests.set(id, { deviceId, resolve });
      });
      const timer = setTimeout(() => {
        hostRequests.get(id)?.resolve({ ok: false, message: "The app did not answer in time." });
        hostRequests.delete(id);
      }, timeoutMs);
      const event = { ...request, id } as HostRequest;
      for (const response of targets) {
        if (!response.writableEnded) response.write(`event: hostRequest\ndata: ${encodeRemoteJson(event)}\n\n`);
      }
      try {
        return await answer;
      } finally {
        clearTimeout(timer);
      }
    },
    handle(request, response) {
      route(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (!(error instanceof HttpError)) {
          logger.warn("http_request_failed", { name: error instanceof Error ? error.name : "unknown" });
        }
        sendError(
          response,
          error instanceof HttpError
            ? error
            : new HttpError(500, "internal_error", "The server could not complete the request."),
        );
      });
    },
    closeStreams() {
      for (const response of streams.keys()) response.end();
      streams.clear();
    },
  };
}

function parseHostResponse(body: Record<string, unknown>): HostResponse {
  if (body.ok === false) {
    return { ok: false, message: typeof body.message === "string" ? body.message.slice(0, 500) : "The app failed." };
  }
  const value = body.value;
  if (value === undefined) return { ok: true };
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((item) => typeof item === "string" && item.length < 4096)
  ) {
    throw invalidRequest();
  }
  return { ok: true, value: value as string[] };
}

function hostNameOf(host: string | undefined): string {
  try {
    return host ? new URL(`http://${host}`).hostname : "";
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}
