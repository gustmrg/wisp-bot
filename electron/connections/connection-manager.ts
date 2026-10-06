import { WispBackendError } from "../../backend/backend-error.js";
import type { HandlerEvent } from "../../backend/handlers/guarded-handlers.js";
import { disposeWithin } from "../../backend/runtime.js";
import type { StructuredLogger } from "../../backend/structured-logger.js";
import { RemoteSession, type RemoteTransport } from "../../client/remote-session.js";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionStatus,
  type ConnectionsView,
  type RemoteConnectionProfile,
  type SshConnectionProfile,
} from "../../shared/connections.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { ConnectionStore } from "./connection-store.js";

export type OperationListener = (event: HandlerEvent, payload: unknown) => Promise<BackendResult<unknown>>;

/** The backend running on this computer, with its operations by IPC channel. */
export interface LocalBackend {
  operations: ReadonlyMap<string, OperationListener>;
  dispose(): Promise<void>;
}

export interface ConnectionManagerOptions {
  store: ConnectionStore;
  /** Starts the local backend; `publish` sends its pushed events to the renderer. */
  createLocalBackend(publish: (channel: string, payload: unknown) => void): Promise<LocalBackend>;
  openSshTunnel(profile: SshConnectionProfile, signal: AbortSignal): Promise<RemoteTransport>;
  deviceName: string;
  /** Sends a push channel payload to every renderer window. */
  broadcast(channel: string, payload: unknown): void;
  logger: Pick<StructuredLogger, "info" | "warn">;
  /** How long local Wisps may take to settle when switching away from this computer. */
  localShutdownTimeoutMs?: number;
}

const OPERATIONS_BY_CHANNEL = new Map<string, string>(
  Object.entries(WISP_IPC_CHANNELS).map(([operation, channel]) => [channel, operation]),
);
const PUSHED = new Set(["agentEvent", "conversationChanged", "mcpSettingsChanged"]);

/**
 * Owns where the backend runs. Exactly one target is active: the local
 * backend, started only while it is chosen, or a session with a Wisp server.
 * Renderer requests go to the active target, and only its events reach the
 * renderer.
 */
export class ConnectionManager {
  private status: ConnectionStatus = { profileId: LOCAL_CONNECTION_ID, phase: "connecting", epoch: 0 };
  private local: { ready: Promise<LocalBackend | undefined>; backend?: LocalBackend } | undefined;
  private session: RemoteSession | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: ConnectionManagerOptions) {}

  /** Opens the connection chosen last time; resolves once a local backend is ready. */
  start(): Promise<void> {
    return this.serialized(() => this.open(this.options.store.active.id, undefined, false));
  }

  view(): ConnectionsView {
    const { store } = this.options;
    return {
      activeId: store.active.id,
      profiles: store.list().map((profile) => ({
        ...profile,
        paired: profile.kind === "local" || Boolean(store.loadCredentials(profile.id)),
      })),
      status: { ...this.status },
      secureStorageAvailable: store.secureStorageAvailable,
    };
  }

  /** Runs a renderer request on the active target. */
  async dispatch(channel: string, event: HandlerEvent, payload: unknown): Promise<BackendResult<unknown>> {
    if (this.local) {
      const backend = await this.local.ready;
      const listener = backend?.operations.get(channel);
      if (listener) return listener(event, payload);
    } else if (this.session) {
      const operation = OPERATIONS_BY_CHANNEL.get(channel);
      if (operation) return this.session.call(operation, payload);
    }
    return {
      ok: false,
      error: { code: "unavailable", message: "Wisp is switching connections. Try again.", retryable: true },
    };
  }

  activate(id: string, pairingCode?: string): Promise<ConnectionsView> {
    return this.serialized(async () => {
      if (!this.options.store.get(id)) throw new WispBackendError("not_found", "That connection no longer exists.");
      const sameRemote = id === this.status.profileId && this.session;
      if (sameRemote) this.session?.start(pairingCode);
      else if (id !== this.status.profileId || this.status.phase === "error") await this.open(id, pairingCode, true);
      return this.view();
    });
  }

  /** Retries the active connection now. */
  retry(): Promise<ConnectionsView> {
    return this.serialized(async () => {
      if (this.session) this.session.start();
      else if (this.status.phase === "error") await this.open(this.status.profileId, undefined, true);
      return this.view();
    });
  }

  save(request: unknown): Promise<ConnectionsView> {
    return this.serialized(async () => {
      const profile = await this.options.store.save(request);
      // New settings for the active server take effect right away.
      if (profile.id === this.status.profileId) await this.open(profile.id, undefined, true);
      else this.publish();
      return this.view();
    });
  }

  remove(id: string): Promise<ConnectionsView> {
    return this.serialized(async () => {
      if (id === LOCAL_CONNECTION_ID) throw new WispBackendError("invalid_request", "This computer cannot be removed.");
      const active = id === this.status.profileId;
      await this.options.store.remove(id);
      if (active) await this.open(LOCAL_CONNECTION_ID, undefined, true);
      else this.publish();
      return this.view();
    });
  }

  /** Disconnects or stops the local backend; Wisps on a server keep running. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.serialized(async () => {
      await this.close();
      await this.options.store.flush();
    });
  }

  private async open(id: string, pairingCode: string | undefined, userInitiated: boolean): Promise<void> {
    await this.close();
    if (this.disposed) return;
    const profile = this.options.store.get(id) ?? this.options.store.active;
    if (profile.id !== this.options.store.active.id) await this.options.store.setActive(profile.id);
    if (profile.kind === "local") await this.openLocal();
    else this.openRemote(profile, pairingCode, userInitiated);
  }

  private async openLocal(): Promise<void> {
    this.setStatus({
      profileId: LOCAL_CONNECTION_ID,
      phase: "connecting",
      message: "Starting Wisps on this computer…",
    });
    const entry: { ready: Promise<LocalBackend | undefined>; backend?: LocalBackend } = {
      ready: Promise.resolve(undefined),
    };
    entry.ready = this.options
      .createLocalBackend((channel, payload) => {
        if (this.local === entry) this.options.broadcast(channel, payload);
      })
      .then(
        (backend) => {
          entry.backend = backend;
          return backend;
        },
        (error: unknown) => {
          this.options.logger.warn("local_backend_failed", { name: error instanceof Error ? error.name : "unknown" });
          return undefined;
        },
      );
    this.local = entry;
    const backend = await entry.ready;
    if (this.local !== entry) return;
    if (backend) this.setStatus({ profileId: LOCAL_CONNECTION_ID, phase: "local" }, true);
    else {
      this.local = undefined;
      this.setStatus({
        profileId: LOCAL_CONNECTION_ID,
        phase: "error",
        message: "Wisps on this computer could not start. Restart Wisp.",
      });
    }
  }

  private openRemote(profile: RemoteConnectionProfile, pairingCode: string | undefined, userInitiated: boolean): void {
    const { store } = this.options;
    this.setStatus({ profileId: profile.id, phase: "connecting", message: `Connecting to ${profile.name}…` });
    const session = new RemoteSession({
      serverName: profile.name,
      deviceName: this.options.deviceName,
      openTransport: (signal) =>
        profile.kind === "ssh"
          ? this.options.openSshTunnel(profile, signal)
          : Promise.resolve(directTransport(profile.url)),
      credentials: {
        load: () => store.loadCredentials(profile.id),
        save: async (credentials) => {
          await store.saveCredentials(profile.id, credentials);
          if (this.session === session) this.publish();
        },
      },
      onStatus: (phase, message) => {
        if (this.session !== session) return;
        this.setStatus({ profileId: profile.id, phase, ...(message ? { message } : {}) });
      },
      onEvent: (type, payload) => {
        if (this.session === session && PUSHED.has(type)) {
          this.options.broadcast(WISP_IPC_CHANNELS[type], payload);
        }
      },
      onReset: () => {
        if (this.session === session) this.setStatus({ ...this.status }, true);
      },
    });
    this.session = session;
    session.start(pairingCode, userInitiated);
  }

  private async close(): Promise<void> {
    const { local, session } = this;
    this.local = undefined;
    this.session = undefined;
    await session?.stop();
    const backend = await local?.ready;
    if (backend) {
      const settled = await disposeWithin(() => backend.dispose(), this.options.localShutdownTimeoutMs ?? 5_000);
      if (!settled) this.options.logger.warn("local_backend_shutdown_timeout", {});
    }
  }

  private setStatus(next: Omit<ConnectionStatus, "epoch">, reset = false): void {
    // A different profile is always a different backend for the renderer.
    const changedTarget = next.profileId !== this.status.profileId;
    this.status = { ...next, epoch: this.status.epoch + (reset || changedTarget ? 1 : 0) };
    this.publish();
  }

  private publish(): void {
    this.options.broadcast(WISP_IPC_CHANNELS.connectionsChanged, this.view());
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

function directTransport(url: string): RemoteTransport {
  return { baseUrl: url, closed: new Promise(() => undefined), close: () => undefined };
}
