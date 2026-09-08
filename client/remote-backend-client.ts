import type { BackendApi } from "../shared/backend-api.js";
import type { ConnectionState } from "../shared/connections.js";
import type {
  BackendError,
  BackendResult,
  ConversationRequest,
  SequencedConversationAgentEvent,
} from "../shared/contracts.js";
import {
  type DeviceCredentials,
  REMOTE_API_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  type RemoteEvent,
  type RemoteRequestState,
  type RemoteServerDescriptor,
  type RemoteSnapshot,
  RemoteTransportError,
  type WebSession,
} from "../shared/remote-protocol.js";
import { consumeEventStream } from "./event-stream.js";

type TokenAuth = {
  kind: "bearer";
  credentials?: DeviceCredentials;
  onCredentials?: (credentials: DeviceCredentials | undefined) => void | Promise<void>;
};
type CookieAuth = { kind: "cookie" };
export interface RemoteClientOptions {
  baseUrl: string;
  auth: TokenAuth | CookieAuth;
  expectedServerId?: string;
  /** Only the Electron SSH adapter may opt in to HTTP on loopback. */
  allowLoopbackHttp?: boolean;
  fetch?: typeof fetch;
}
const empty = { ok: true, value: {} } as const;
function latestCursor(current: string | undefined, next: string): string {
  const previous = current?.match(/^([^:]+):(\d{1,19})$/);
  const candidate = next.match(/^([^:]+):(\d{1,19})$/);
  return previous && candidate && previous[1] === candidate[1] && BigInt(previous[2]!) > BigInt(candidate[2]!)
    ? current!
    : next;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const failure = (error: unknown): BackendResult<never> => ({
  ok: false,
  error:
    error instanceof RemoteTransportError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : {
          code: "transport_unavailable",
          message: "The server could not be reached. Reconnect and check the request status before retrying.",
          retryable: true,
        },
});
export function validateRemoteEndpoint(endpoint: string, allowLoopbackHttp = false): string {
  const url = new URL(endpoint);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(allowLoopbackHttp && loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("Use the HTTPS origin of the Wisp server, without a path or credentials.");
  return url.origin;
}
function checkSnapshot(value: unknown): asserts value is RemoteSnapshot {
  if (
    !object(value) ||
    typeof value.serverId !== "string" ||
    typeof value.bootId !== "string" ||
    typeof value.cursor !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    !object(value.revisions) ||
    !Number.isSafeInteger(value.settingsRevision) ||
    !object(value.state) ||
    !object(value.state.chats) ||
    !object(value.state.statuses) ||
    !Array.isArray(value.state.pendingToolApprovals) ||
    typeof value.state.initialized !== "boolean" ||
    !Number.isSafeInteger(value.state.agentEventSequence)
  )
    throw new RemoteTransportError("protocol_incompatible", "The server returned an incompatible snapshot.");
}

async function readJsonResponse(response: Response, maximumBytes = 16 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new RemoteTransportError("protocol_incompatible", "The server returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes)
        throw new RemoteTransportError("protocol_incompatible", "The server response exceeds the supported limit.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class RemoteBackendClient {
  readonly api: BackendApi;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private credentials: DeviceCredentials | undefined;
  private csrfToken: string | undefined;
  private descriptor: RemoteServerDescriptor | undefined;
  private snapshot: RemoteSnapshot | undefined;
  private cursor: string | undefined;
  private controller: AbortController | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private resumePromise: Promise<RemoteSnapshot> | undefined;
  private refreshStatePromise: Promise<RemoteSnapshot> | undefined;
  private refreshStateDirty = false;
  private generation = 0;
  private retryCount = 0;
  private state: ConnectionState = { phase: "disconnected", profileId: "remote", generation: 0 };
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: RemoteSnapshot) => void>();
  private readonly agentListeners = new Set<(event: SequencedConversationAgentEvent) => void>();
  constructor(private readonly options: RemoteClientOptions) {
    this.baseUrl = validateRemoteEndpoint(options.baseUrl, options.allowLoopbackHttp);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.auth.kind === "bearer" ? options.auth.credentials : undefined;
    const conversation = (request: ConversationRequest): string =>
      `/conversations/${encodeURIComponent(request.conversationId)}`;
    const revision = (id: string): number => this.snapshot?.revisions[id] ?? 0;
    const settingsRevision = (): number => this.snapshot?.settingsRevision ?? 0;
    const request = <T>(path: string, method = "GET", body?: unknown): Promise<BackendResult<T>> =>
      this.result<T>(path, method, body);
    this.api = {
      startConversation: (r) => request(`${conversation(r)}/start`, "POST", {}),
      sendMessage: async (r) => {
        const result = await request<RemoteRequestState>(`${conversation(r)}/messages`, "POST", {
          requestId: r.requestId,
          text: r.text,
        });
        if (result.ok) return empty;
        if (result.error.code === "transport_unavailable") {
          const status = await this.getRequest(r.conversationId, r.requestId);
          if (status.ok) return empty;
        }
        return result;
      },
      abortConversation: (r) => request(`${conversation(r)}/abort`, "POST", {}),
      applyModel: (r) =>
        request(`${conversation(r)}/model`, "PUT", {
          model: r.model,
          expectedRevision: r.expectedRevision ?? revision(r.conversationId),
        }),
      getConversationModel: (r) => request(`${conversation(r)}/model`),
      manageContext: (r) =>
        request(`${conversation(r)}/context`, "POST", {
          command: r.command,
          expectedRevision: r.expectedRevision ?? revision(r.conversationId),
        }),
      // A renderer teardown never controls the lifetime of an agent on the server.
      disposeConversation: async () => empty,
      subscribeToAgentEvents: (listener) => {
        this.agentListeners.add(listener);
        return () => {
          this.agentListeners.delete(listener);
        };
      },
      getAiSettings: () => request("/settings/ai"),
      saveAiSettings: (r) =>
        request("/settings/ai", "PUT", { ...r, expectedRevision: r.expectedRevision ?? settingsRevision() }),
      removeProviderCredential: (r) =>
        request(`/settings/ai/credentials/${encodeURIComponent(r.providerId)}`, "DELETE", {
          expectedRevision: r.expectedRevision ?? settingsRevision(),
        }),
      getConversationMessages: (r) =>
        request(
          `${conversation(r)}/messages?limit=${r.limit ?? 200}${r.before ? `&before=${encodeURIComponent(r.before)}` : ""}`,
        ),
      getConversationState: async () => {
        try {
          return { ok: true, value: (await this.loadSnapshot()).state };
        } catch (error) {
          return failure(error);
        }
      },
      initializeConversations: async () => this.api.getConversationState(),
      createConversation: (r) => request("/conversations", "POST", r),
      updateConversation: (r) =>
        request(conversation(r), "PATCH", {
          changes: r.changes,
          expectedRevision: r.expectedRevision ?? revision(r.conversationId),
        }),
      deleteConversation: (r) =>
        request(conversation(r), "DELETE", { expectedRevision: r.expectedRevision ?? revision(r.conversationId) }),
      appendConversationMessage: async () => ({
        ok: false,
        error: {
          code: "invalid_request",
          message: "Remote messages must be admitted through sendMessage with a request ID.",
          retryable: false,
        },
      }),
      answerConversationPrompt: (r) =>
        request(`${conversation(r)}/prompts/${encodeURIComponent(r.messageId)}/answer`, "POST", { answer: r.answer }),
      markConversationRead: (r) => request(`${conversation(r)}/read`, "POST", {}),
      getSessionReport: (r) => request(`${conversation(r)}/session-report`),
      getUsageReport: (r) => request(`/usage?period=${encodeURIComponent(r.period)}`),
      getToolPolicy: () => request("/tool-policy"),
      saveToolPolicy: (settings, expectedRevision) =>
        request("/tool-policy", "PUT", {
          settings,
          expectedRevision: expectedRevision ?? settings.revision ?? settingsRevision(),
        }),
      resolveToolApproval: (r) => request(`/approvals/${encodeURIComponent(r.approvalId)}/resolve`, "POST", r),
      subscribeToConversationState: (listener) => this.subscribeToSnapshot((value) => listener(value.state)),
      refreshConnection: async () => {
        try {
          return { ok: true, value: (await this.resume()).state };
        } catch (error) {
          return failure(error);
        }
      },
    };
  }
  getState(): ConnectionState {
    return this.state;
  }
  getServer(): RemoteServerDescriptor | undefined {
    return this.descriptor;
  }
  getSnapshot(): RemoteSnapshot | undefined {
    return this.snapshot;
  }
  subscribeToState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  subscribeToSnapshot(listener: (snapshot: RemoteSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }
  private setState(phase: ConnectionState["phase"], message?: string): void {
    this.state = {
      phase,
      profileId: "remote",
      generation: this.generation,
      serverId: this.descriptor?.serverId,
      owner: this.descriptor?.owner,
      message,
    };
    for (const listener of this.stateListeners) listener(this.state);
  }
  async pair(code: string, deviceName: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(code) || !deviceName.trim() || deviceName.length > 100)
      throw new RemoteTransportError("invalid_request", "Enter a valid pairing code and device name.");
    const value = await this.json<DeviceCredentials | WebSession>(
      "/auth/pair",
      "POST",
      { code, deviceName, mode: this.options.auth.kind === "cookie" ? "web" : "token" },
      false,
    );
    await this.acceptSession(value);
  }
  async connect(): Promise<RemoteSnapshot> {
    this.disconnect();
    this.generation += 1;
    this.setState("connecting");
    return this.resume();
  }
  resume(): Promise<RemoteSnapshot> {
    if (this.resumePromise) return this.resumePromise;
    const pending = this.resumeInternal().finally(() => {
      if (this.resumePromise === pending) this.resumePromise = undefined;
    });
    this.resumePromise = pending;
    return pending;
  }
  private async resumeInternal(): Promise<RemoteSnapshot> {
    this.stopStream();
    this.setState("reconnecting");
    const generation = this.generation;
    try {
      if (this.options.auth.kind === "cookie")
        await this.acceptSession(await this.json<WebSession>("/auth/session", "GET", undefined, false));
      const descriptor = await this.json<RemoteServerDescriptor>("/server");
      if (
        !object(descriptor) ||
        descriptor.protocolVersion !== REMOTE_PROTOCOL_VERSION ||
        typeof descriptor.serverId !== "string" ||
        typeof descriptor.bootId !== "string" ||
        !object(descriptor.owner) ||
        typeof descriptor.owner.id !== "string" ||
        typeof descriptor.owner.name !== "string" ||
        !Array.isArray(descriptor.capabilities)
      )
        throw new RemoteTransportError("protocol_incompatible", "This server requires another version of Wisp.");
      const expected = this.options.expectedServerId ?? this.credentials?.serverId ?? this.descriptor?.serverId;
      if (expected && descriptor.serverId !== expected)
        throw new RemoteTransportError(
          "server_identity_changed",
          "The server identity changed. Verify the instance before pairing a new profile.",
        );
      if (generation !== this.generation)
        throw new RemoteTransportError("transport_unavailable", "The connection changed.");
      this.descriptor = descriptor;
      const snapshot = await this.loadSnapshot();
      if (generation !== this.generation)
        throw new RemoteTransportError("transport_unavailable", "The connection changed.");
      await this.openStream();
      return snapshot;
    } catch (error) {
      if (generation === this.generation)
        this.setState(
          error instanceof RemoteTransportError && error.code === "unauthorized" ? "pairing_required" : "error",
          error instanceof RemoteTransportError ? error.message : "The server connection failed.",
        );
      throw error;
    }
  }
  disconnect(): void {
    this.generation += 1;
    this.resumePromise = undefined;
    this.refreshStatePromise = undefined;
    this.stopStream();
    this.setState("disconnected");
  }
  async logout(): Promise<void> {
    try {
      await this.json("/auth/logout", "POST", this.credentials ? { refreshToken: this.credentials.refreshToken } : {});
    } finally {
      this.credentials = undefined;
      this.csrfToken = undefined;
      if (this.options.auth.kind === "bearer") await this.options.auth.onCredentials?.(undefined);
      this.disconnect();
    }
  }
  getRequest(conversationId: string, requestId: string): Promise<BackendResult<RemoteRequestState>> {
    return this.result(
      `/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}`,
    );
  }
  private stopStream(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }
  private async acceptSession(value: DeviceCredentials | WebSession): Promise<void> {
    if (
      !object(value) ||
      typeof value.serverId !== "string" ||
      typeof value.deviceId !== "string" ||
      typeof value.expiresAt !== "string"
    )
      throw new RemoteTransportError("protocol_incompatible", "Invalid session response.");
    if (
      (this.options.expectedServerId ?? this.descriptor?.serverId ?? this.credentials?.serverId) &&
      (this.options.expectedServerId ?? this.descriptor?.serverId ?? this.credentials?.serverId) !== value.serverId
    )
      throw new RemoteTransportError("server_identity_changed", "The pairing code belongs to a different server.");
    if (this.options.auth.kind === "bearer") {
      if (!("accessToken" in value) || typeof value.accessToken !== "string" || typeof value.refreshToken !== "string")
        throw new RemoteTransportError("protocol_incompatible", "Invalid device credential response.");
      const credentials: DeviceCredentials = {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
        deviceId: value.deviceId,
        serverId: value.serverId,
      };
      this.credentials = credentials;
      await this.options.auth.onCredentials?.(credentials);
    } else {
      if (typeof value.csrfToken !== "string")
        throw new RemoteTransportError("protocol_incompatible", "Invalid browser session response.");
      this.csrfToken = value.csrfToken;
    }
  }
  private async refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        if (this.options.auth.kind === "bearer" && !this.credentials)
          throw new RemoteTransportError("unauthorized", "Pair this device with the server.");
        const session = await this.json<DeviceCredentials | WebSession>(
          "/auth/refresh",
          "POST",
          this.credentials ? { refreshToken: this.credentials.refreshToken } : {},
          false,
        );
        await this.acceptSession(session);
      })().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }
  private headers(method: string): Headers {
    const headers = new Headers({ Accept: "application/json" });
    if (this.credentials) headers.set("Authorization", `Bearer ${this.credentials.accessToken}`);
    if (method !== "GET") {
      headers.set("Content-Type", "application/json");
      if (this.csrfToken) headers.set("X-Wisp-CSRF", this.csrfToken);
    }
    return headers;
  }
  private async json<T>(path: string, method = "GET", body?: unknown, allowRefresh = true): Promise<T> {
    // Legacy cards may contain up to 100 bounded items. Normal history pages are
    // byte-limited by the server; allow a single valid large card without truncation.
    const maximumResponseBytes =
      /^\/conversations\/[^/]+\/messages\?/.test(path) && method === "GET" ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${REMOTE_API_PREFIX}${path}`, {
        method,
        headers: this.headers(method),
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: this.options.auth.kind === "cookie" ? "include" : "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new RemoteTransportError(
        "transport_unavailable",
        "The server could not be reached. Reconnect and check the request status before retrying.",
        true,
      );
    }
    if (response.status === 401 && allowRefresh) {
      await response.body?.cancel();
      await this.refresh();
      return this.json(path, method, body, false);
    }
    if (response.status === 403 && allowRefresh && this.options.auth.kind === "cookie" && method !== "GET") {
      // Another tab may have rotated the shared HttpOnly cookie. A rejected CSRF
      // request has no effects, so update its verification token once before retrying.
      const previousCsrf = this.csrfToken;
      await this.acceptSession(await this.json<WebSession>("/auth/session", "GET", undefined, false));
      if (previousCsrf !== this.csrfToken) {
        await response.body?.cancel();
        return this.json(path, method, body, false);
      }
    }
    if (Number(response.headers.get("content-length")) > maximumResponseBytes)
      throw new RemoteTransportError("protocol_incompatible", "The server response exceeds the supported limit.");
    let result: unknown;
    try {
      result = await readJsonResponse(response, maximumResponseBytes);
    } catch {
      throw new RemoteTransportError("protocol_incompatible", "The server returned an invalid response.");
    }
    if (!object(result) || typeof result.ok !== "boolean")
      throw new RemoteTransportError("protocol_incompatible", "The server returned an invalid response.");
    if (!result.ok) {
      const error = object(result.error) ? result.error : {};
      const allowed = new Set([
        "aborted",
        "already_exists",
        "configuration_required",
        "disposed",
        "internal_error",
        "invalid_configuration",
        "invalid_request",
        "not_found",
        "model_unavailable",
        "approval_expired",
        "tool_blocked",
        "secure_storage_unavailable",
        "transport_unavailable",
        "protocol_incompatible",
        "server_identity_changed",
        "resync_required",
        "conflict",
        "unauthorized",
        "forbidden",
        "capacity_exceeded",
        "interrupted",
      ]);
      const code =
        typeof error.code === "string" && allowed.has(error.code)
          ? (error.code as BackendError["code"])
          : response.status === 401
            ? "unauthorized"
            : "internal_error";
      throw new RemoteTransportError(
        code,
        typeof error.message === "string" && error.message.length <= 500
          ? error.message
          : "The server rejected the request.",
        error.retryable === true,
      );
    }
    if (!response.ok) throw new RemoteTransportError("internal_error", "The server rejected the request.");
    return result.value as T;
  }
  private async result<T>(path: string, method = "GET", body?: unknown): Promise<BackendResult<T>> {
    const generation = this.generation;
    if (
      !this.descriptor ||
      (method === "GET" ? !["connected", "reconnecting"].includes(this.state.phase) : this.state.phase !== "connected")
    )
      return failure(
        new RemoteTransportError("transport_unavailable", "Connect to the server before making changes.", true),
      );
    try {
      const value = await this.json<T>(path, method, body);
      if (generation !== this.generation)
        return failure(
          new RemoteTransportError("transport_unavailable", "The connection changed before the request completed."),
        );
      if (method !== "GET") await this.loadSnapshot().catch(() => undefined);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof RemoteTransportError && error.code === "conflict")
        await this.loadSnapshot().catch(() => undefined);
      return failure(error);
    }
  }
  private async loadSnapshot(): Promise<RemoteSnapshot> {
    if (this.refreshStatePromise) {
      this.refreshStateDirty = true;
      return this.refreshStatePromise;
    }
    const generation = this.generation;
    const pending = (async () => {
      let value: RemoteSnapshot;
      do {
        this.refreshStateDirty = false;
        value = await this.json<RemoteSnapshot>("/snapshot");
        checkSnapshot(value);
        if (generation !== this.generation)
          throw new RemoteTransportError("transport_unavailable", "The connection changed.");
        if (this.descriptor && value.serverId !== this.descriptor.serverId)
          throw new RemoteTransportError("server_identity_changed", "The server identity changed.");
        this.snapshot = value;
        this.cursor = latestCursor(this.cursor, value.cursor);
        for (const listener of this.snapshotListeners) listener(value);
        // An event arriving during this read may describe a commit newer than the
        // returned snapshot. Coalesce it into another read instead of losing it.
      } while (this.refreshStateDirty);
      return value;
    })().finally(() => {
      if (this.refreshStatePromise === pending) this.refreshStatePromise = undefined;
    });
    this.refreshStatePromise = pending;
    return pending;
  }
  private async openStream(recoveryAttempt = 0): Promise<void> {
    if (recoveryAttempt > 1)
      throw new RemoteTransportError(
        "unauthorized",
        "The server event stream rejected this session. Pair this device again.",
      );
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    const headers = this.headers("GET");
    headers.set("Accept", "text/event-stream");
    const headerTimeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.baseUrl}${REMOTE_API_PREFIX}/events?after=${encodeURIComponent(this.cursor ?? "")}`,
        {
          headers,
          credentials: this.options.auth.kind === "cookie" ? "include" : "omit",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(headerTimeout);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      await this.refresh();
      return this.openStream(recoveryAttempt + 1);
    }
    if (response.status === 409 || response.status === 410) {
      await response.body?.cancel();
      await this.loadSnapshot();
      return this.openStream(recoveryAttempt + 1);
    }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      throw new RemoteTransportError("transport_unavailable", "The server event stream is unavailable.", true);
    }
    if (generation !== this.generation || controller.signal.aborted) {
      await response.body?.cancel();
      return;
    }
    this.retryCount = 0;
    this.setState("connected");
    void consumeEventStream(
      response,
      (event) => {
        if (event.event === "resync_required")
          throw new RemoteTransportError("resync_required", "Reloading server state.");
        if (event.event !== "wisp") return;
        const value = JSON.parse(event.data) as RemoteEvent;
        if (
          !object(value) ||
          value.protocolVersion !== REMOTE_PROTOCOL_VERSION ||
          value.serverId !== this.descriptor?.serverId ||
          typeof value.eventId !== "string" ||
          typeof value.type !== "string" ||
          !object(value.payload)
        )
          throw new RemoteTransportError("protocol_incompatible", "Invalid server event.");
        if (
          generation !== this.generation ||
          value.eventId === this.cursor ||
          latestCursor(this.cursor, value.eventId) !== value.eventId
        )
          return;
        this.cursor = value.eventId;
        if (
          value.type === "agent" &&
          (!Number.isSafeInteger(value.payload.sequence) ||
            typeof value.payload.conversationId !== "string" ||
            typeof value.payload.type !== "string")
        )
          throw new RemoteTransportError("protocol_incompatible", "Invalid agent event.");
        if (value.type === "agent")
          for (const listener of this.agentListeners) listener(value.payload as SequencedConversationAgentEvent);
        else
          void this.loadSnapshot().catch(() => {
            controller.abort();
            this.scheduleReconnect(generation);
          });
      },
      controller.signal,
    )
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted && generation === this.generation) this.scheduleReconnect(generation);
      });
  }
  private scheduleReconnect(generation: number): void {
    if (generation !== this.generation || this.retryTimer) return;
    this.setState("reconnecting", "Reconnecting to the server. Agents continue running remotely.");
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.retryCount++, 6)) * (0.8 + Math.random() * 0.4);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.resume().catch((error: unknown) => {
        if (
          !(error instanceof RemoteTransportError) ||
          !["unauthorized", "server_identity_changed", "protocol_incompatible"].includes(error.code)
        )
          this.scheduleReconnect(generation);
      });
    }, delay);
  }
}
