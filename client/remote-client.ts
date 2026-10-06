import type { BackendResult } from "../shared/contracts.js";
import { decodeRemoteJson, encodeRemoteJson } from "../shared/remote-codec.js";
import {
  REMOTE_API_PREFIX,
  type DeviceCredentials,
  type HostResponse,
  type RemoteEventType,
  type RemoteTransportErrorCode,
  type ServerDescriptor,
  type WebSession,
  WORKSPACE_UPLOAD_PATH,
} from "../shared/remote-protocol.js";
import type { WorkspaceAttachment } from "../shared/workspace.js";
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

/** Bearer credentials (desktop), or a browser's knowledge of its cookie session. */
export type StoredSession = DeviceCredentials | WebSession;

export interface CredentialStore {
  load(): StoredSession | undefined;
  /** Persists rotated credentials; `undefined` forgets them after the device lost access. */
  save(credentials: StoredSession | undefined): Promise<void>;
}

export interface RemoteClientOptions {
  /** The server origin, such as `http://127.0.0.1:43210` for a tunnel. */
  baseUrl: string;
  credentials: CredentialStore;
  /**
   * Authenticate with the server's HttpOnly cookies instead of bearer tokens,
   * as a browser app served by the server does. No token reaches the page.
   */
  cookies?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Marks a cookie-authenticated request as the app's own; cross-site forms cannot set it. */
const COOKIE_HEADERS: Record<string, string> = { "X-Wisp-Request": "1" };

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
  private refreshing: Promise<StoredSession> | undefined;

  constructor(private readonly options: RemoteClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async pair(code: string, deviceName: string): Promise<StoredSession> {
    const session = valueOf(
      await this.request("/auth/pair", { code, deviceName, ...(this.options.cookies ? { mode: "web" } : {}) }),
    ) as StoredSession;
    await this.options.credentials.save(session);
    return session;
  }

  /** Ends this device's access to the server. */
  async signOut(): Promise<void> {
    await this.authorized("POST", "/auth/logout", {});
    await this.options.credentials.save(undefined);
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

  /**
   * Sends one file into a Wisp's workspace. No timeout applies: a large file
   * over a slow link takes as long as it takes, and the server closes a
   * connection that stops sending.
   */
  async uploadWorkspaceFile(
    conversationId: string,
    name: string,
    content: Blob,
  ): Promise<BackendResult<WorkspaceAttachment>> {
    const query = new URLSearchParams({ conversationId, name });
    const attempt = async (auth: Record<string, string>): Promise<Response> =>
      this.send(`${REMOTE_API_PREFIX}${WORKSPACE_UPLOAD_PATH}?${query}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: content,
      });
    let response = await attempt(await this.authHeaders());
    // A Blob can be sent again, so the same retry as `authorized` applies.
    if (response.status === 401) response = await attempt(await this.authHeaders(true));
    return (await this.bodyOf(response)) as BackendResult<WorkspaceAttachment>;
  }

  /** Answers a server's request to act on this computer's screen. */
  async answerHostRequest(id: string, response: HostResponse): Promise<void> {
    await this.authorized("POST", `/host-requests/${encodeURIComponent(id)}`, response);
  }

  /** Streams events after `cursor` until the server ends the stream or `signal` aborts. */
  async streamEvents(cursor: string | undefined, handlers: EventStreamHandlers, signal: AbortSignal): Promise<void> {
    // An abort listener added after the abort never runs.
    if (signal.aborted) return;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(abort, STREAM_IDLE_TIMEOUT_MS);
    };
    try {
      const open = (auth: Record<string, string>): Promise<Response> =>
        this.send(`${REMOTE_API_PREFIX}/events`, {
          headers: { ...auth, ...(cursor ? { "Last-Event-ID": cursor } : {}) },
          signal: controller.signal,
        });
      let response = await open(await this.authHeaders());
      if (response.status === 401) response = await open(await this.authHeaders(true));
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
    const attempt = async (auth: Record<string, string>): Promise<Response> =>
      this.send(`${REMOTE_API_PREFIX}${path}`, {
        method,
        headers: {
          ...auth,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: encodeRemoteJson(body) }),
        ...(timeout ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {}),
      });
    let response = await attempt(await this.authHeaders());
    // A 401 means the request never ran, so repeating it once with fresh credentials is safe.
    if (response.status === 401) response = await attempt(await this.authHeaders(true));
    return this.bodyOf(response);
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const response = await this.send(`${REMOTE_API_PREFIX}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.options.cookies ? COOKIE_HEADERS : {}) },
      body: encodeRemoteJson(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return this.bodyOf(response);
  }

  /** Headers that authenticate a request, refreshing first when asked or when the access token is about to expire. */
  private async authHeaders(refreshFirst = false): Promise<Record<string, string>> {
    let session = this.options.credentials.load();
    if (!session) throw new RemoteError("unauthorized", "This device is not paired with the server.");
    if (refreshFirst || Date.parse(session.accessExpiresAt) - REFRESH_MARGIN_MS <= this.now()) {
      session = await this.refresh();
    }
    if (this.options.cookies) return COOKIE_HEADERS;
    return { Authorization: `Bearer ${(session as DeviceCredentials).accessToken}` };
  }

  /** Rotates credentials once for every concurrent caller. */
  private refresh(): Promise<StoredSession> {
    this.refreshing ??= (async () => {
      const current = this.options.credentials.load();
      if (!current) throw new RemoteError("unauthorized", "This device is not paired with the server.");
      try {
        // A browser's refresh token is a cookie the page cannot read.
        const body = this.options.cookies ? {} : { refreshToken: (current as DeviceCredentials).refreshToken };
        const next = valueOf(await this.request("/auth/refresh", body)) as StoredSession;
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
      return await this.fetch(new URL(path, this.options.baseUrl), {
        ...init,
        ...(this.options.cookies ? { credentials: "same-origin" as const } : {}),
      });
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
