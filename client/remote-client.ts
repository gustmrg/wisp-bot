import type { BackendResult } from "../shared/contracts.js";
import { decodeRemoteJson, encodeRemoteJson } from "../shared/remote-codec.js";
import {
  REMOTE_API_PREFIX,
  type DeviceCredentials,
  type RemoteEventType,
  type RemoteTransportErrorCode,
  type ServerDescriptor,
} from "../shared/remote-protocol.js";
import { readServerSentEvents } from "./sse.js";

// Refresh this long before the access token expires rather than waiting for a 401.
const REFRESH_MARGIN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
// The server sends a keep-alive every 20 seconds; silence this long means the path is dead.
const STREAM_IDLE_TIMEOUT_MS = 45_000;

export type RemoteErrorCode = RemoteTransportErrorCode | "network";

/** A failure to reach the server or to be accepted by it, as opposed to an operation's own error. */
export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

export interface CredentialStore {
  load(): DeviceCredentials | undefined;
  /** Persists rotated credentials; `undefined` forgets them after the device lost access. */
  save(credentials: DeviceCredentials | undefined): Promise<void>;
}

export interface RemoteClientOptions {
  /** The server origin, such as `http://127.0.0.1:43210` for a tunnel. */
  baseUrl: string;
  credentials: CredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Routes other than operations answer `{ ok: true, value }`. */
function valueOf(body: unknown): unknown {
  return (body as { value?: unknown } | null)?.value;
}

export interface EventStreamHandlers {
  /** The stream is open and authorized. */
  onOpen(): void;
  onEvent(id: string | undefined, type: RemoteEventType, payload: unknown): void;
}

/** Speaks the Wisp server protocol for one paired device. */
export class RemoteClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private refreshing: Promise<DeviceCredentials> | undefined;

  constructor(private readonly options: RemoteClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async pair(code: string, deviceName: string): Promise<DeviceCredentials> {
    const credentials = valueOf(await this.request("/auth/pair", { code, deviceName })) as DeviceCredentials;
    await this.options.credentials.save(credentials);
    return credentials;
  }

  async describe(): Promise<ServerDescriptor> {
    return valueOf(await this.authorized("GET", "/server")) as ServerDescriptor;
  }

  /** Runs one operation; transport failures throw `RemoteError`, operation failures return their result. */
  async call(operation: string, payload: unknown): Promise<BackendResult<unknown>> {
    return (await this.authorized(
      "POST",
      `/rpc/${encodeURIComponent(operation)}`,
      payload ?? {},
      true,
    )) as BackendResult<unknown>;
  }

  /** Streams events after `cursor` until the server ends the stream or `signal` aborts. */
  async streamEvents(cursor: string | undefined, handlers: EventStreamHandlers, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(abort, STREAM_IDLE_TIMEOUT_MS);
    };
    try {
      const open = (token: string): Promise<Response> =>
        this.send(`${REMOTE_API_PREFIX}/events`, {
          headers: { Authorization: `Bearer ${token}`, ...(cursor ? { "Last-Event-ID": cursor } : {}) },
          signal: controller.signal,
        });
      let response = await open(await this.accessToken());
      if (response.status === 401) response = await open((await this.refresh()).accessToken);
      if (!response.ok || !response.body) throw await this.failure(response);
      resetIdle();
      handlers.onOpen();
      await readServerSentEvents(
        response.body,
        (message) => {
          handlers.onEvent(message.id, message.event as RemoteEventType, decodeRemoteJson(message.data || "null"));
        },
        resetIdle,
      );
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      if (signal.aborted) return;
      throw new RemoteError("network", "The connection to the server was interrupted.");
    } finally {
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
    }
  }

  private async authorized(method: "GET" | "POST", path: string, body?: unknown, timeout = false): Promise<unknown> {
    const attempt = async (token: string): Promise<Response> =>
      this.send(`${REMOTE_API_PREFIX}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: encodeRemoteJson(body) }),
        ...(timeout ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {}),
      });
    let response = await attempt(await this.accessToken());
    // A 401 means the request never ran, so repeating it once with fresh credentials is safe.
    if (response.status === 401) response = await attempt((await this.refresh()).accessToken);
    return this.bodyOf(response);
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const response = await this.send(`${REMOTE_API_PREFIX}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: encodeRemoteJson(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return this.bodyOf(response);
  }

  private async accessToken(): Promise<string> {
    const credentials = this.options.credentials.load();
    if (!credentials) throw new RemoteError("unauthorized", "This device is not paired with the server.");
    if (Date.parse(credentials.accessExpiresAt) - REFRESH_MARGIN_MS > this.now()) return credentials.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Rotates credentials once for every concurrent caller. */
  private refresh(): Promise<DeviceCredentials> {
    this.refreshing ??= (async () => {
      const current = this.options.credentials.load();
      if (!current) throw new RemoteError("unauthorized", "This device is not paired with the server.");
      try {
        const next = valueOf(
          await this.request("/auth/refresh", { refreshToken: current.refreshToken }),
        ) as DeviceCredentials;
        await this.options.credentials.save(next);
        return next;
      } catch (error) {
        if (error instanceof RemoteError && error.code === "unauthorized")
          await this.options.credentials.save(undefined);
        throw error;
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(new URL(path, this.options.baseUrl), init);
    } catch (error) {
      if (
        init.signal?.aborted &&
        init.signal.reason instanceof DOMException &&
        init.signal.reason.name === "TimeoutError"
      ) {
        throw new RemoteError("network", "The server did not answer in time.");
      }
      if (init.signal?.aborted) throw error;
      throw new RemoteError("network", "The server cannot be reached.");
    }
  }

  private async bodyOf(response: Response): Promise<unknown> {
    if (!response.ok) throw await this.failure(response);
    try {
      return decodeRemoteJson(await response.text());
    } catch {
      throw new RemoteError("network", "The server sent an invalid response.");
    }
  }

  private async failure(response: Response): Promise<RemoteError> {
    let code: RemoteErrorCode = response.status === 401 ? "unauthorized" : "internal_error";
    let message = `The server answered with status ${response.status}.`;
    try {
      const body = JSON.parse(await response.text()) as {
        error?: { code?: RemoteTransportErrorCode; message?: string };
      };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the status-based description.
    }
    return new RemoteError(code, message);
  }
}
