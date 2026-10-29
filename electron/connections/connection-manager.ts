import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { WispBackendError } from "../../backend/backend-error.js";
import type { StructuredLogger } from "../../backend/structured-logger.js";
import {
  RemoteSession,
  TransportError,
  type RemoteSessionPhase,
  type RemoteTransport,
} from "../../client/remote-session.js";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionFailure,
  type ConnectionPhase,
  type ConnectionProfile,
  type ConnectionProgress,
  type ConnectionRetry,
  type ConnectionStatus,
  type ConnectionsView,
  type SshConnectionProfile,
  type SshPromptView,
} from "../../shared/connections.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import {
  REMOTE_HOST_REQUESTS,
  type DeviceCredentials,
  type HostRequest,
  type HostResponse,
} from "../../shared/remote-protocol.js";
import type { LocalServer, LocalServerExposure } from "../local-server/local-server.js";
import {
  advance,
  connectSteps,
  createProgress,
  fail,
  failedAttempt,
  INSTALL_STEPS,
} from "../../shared/connection-progress.js";
import type { ConnectionStore } from "./connection-store.js";
import type { InstallStep } from "./ssh-install.js";

export interface ConnectionManagerOptions {
  store: ConnectionStore;
  /**
   * The Wisp server on this computer, started only while it is the chosen
   * connection, or for as long as the app runs while remote access is on.
   */
  localServer: LocalServer;
  /** Opens a tunnel; `onServerPort` hears the port `wispctl status` reports when it differs from the profile's. */
  openSshTunnel(
    profile: SshConnectionProfile,
    signal: AbortSignal,
    onServerPort: (port: number) => Promise<void>,
  ): Promise<RemoteTransport>;
  /**
   * Installs and starts the Wisp server on the machine behind an SSH profile;
   * reports progress lines, and resolves with the port the server listens on.
   */
  installServer(
    profile: SshConnectionProfile,
    onProgress: (message: string, step: InstallStep) => void,
    signal: AbortSignal,
  ): Promise<number | undefined>;
  /** Does what the local server asks on this computer's screen. */
  onHostRequest(request: HostRequest): Promise<HostResponse>;
  /** Shows a native multi-file picker; resolves with absolute paths, empty when dismissed. */
  selectFiles(): Promise<ReadonlyArray<string>>;
  /** The app left a server; what it was doing for that server, such as a sign-in, ends. */
  onSessionClosed?(): void;
  deviceName: string;
  /** Sends a push channel payload to every renderer window. */
  broadcast(channel: string, payload: unknown): void;
  logger: Pick<StructuredLogger, "info" | "warn">;
  /** Whether this computer already has Wisps from a version that had no connection choice. */
  hasLocalData(): Promise<boolean>;
}

// sshd gives up on a login after two minutes by default.
const SSH_PROMPT_TIMEOUT_MS = 120_000;
const MAX_SSH_ANSWER = 1024;
// While remote access is on, a local server that stopped starts again after this long, or longer after a failed start.
const LOCAL_RESTART_DELAY_MS = 2_000;
const LOCAL_RETRY_DELAY_MS = 30_000;

const OPERATIONS_BY_CHANNEL = new Map<string, string>(
  Object.entries(WISP_IPC_CHANNELS).map(([operation, channel]) => [channel, operation]),
);
const PUSHED = new Set([
  "agentEvent",
  "conversationChanged",
  "wispsChanged",
  "mcpSettingsChanged",
  "pluginSettingsChanged",
  "scheduledMessagesChanged",
  "messageQueueChanged",
  "jobsChanged",
]);

/**
 * Owns where the backend runs. The app is always a client: "This computer"
 * is a Wisp server the app starts as a child process, reached exactly like a
 * server over SSH or HTTPS. Renderer requests go to the active session, and
 * only its events reach the renderer.
 */
export class ConnectionManager {
  private status: ConnectionStatus = { profileId: LOCAL_CONNECTION_ID, phase: "connecting", epoch: 0 };
  /** The steps of the attempt in progress, or of the last one that failed. */
  private progress: ConnectionProgress | undefined;
  /** Automatic retries since the connection failed or dropped. */
  private retrying: ConnectionRetry | undefined;
  private session: RemoteSession | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private installation: { profileId: string; controller: AbortController } | undefined;
  /** Questions OpenSSH is waiting on, oldest first; the renderer shows one at a time. */
  private sshPrompts: Array<{ view: SshPromptView; finish: (answer: string | undefined) => void }> = [];
  private sshPromptCount = 0;
  private started = false;
  /** Set while remote access is on: the local server then runs whichever connection is chosen. */
  private exposure: LocalServerExposure | undefined;
  private watchedLocalExit: Promise<void> | undefined;
  private localRestart: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ConnectionManagerOptions) {}

  /**
   * Opens the connection chosen last time. On a first run nothing starts:
   * the person chooses this computer or a server first. People upgrading
   * with Wisps already on this computer keep using it.
   */
  start(): Promise<void> {
    return this.serialized(async () => {
      const { store } = this.options;
      this.started = true;
      if (!store.hasChoice && !(await this.options.hasLocalData())) {
        this.setStatus({ profileId: LOCAL_CONNECTION_ID, phase: "choosing" });
      } else {
        await this.open(store.active.id, undefined, false);
      }
      this.keepLocalServerRunning();
    });
  }

  /**
   * Sets how Wisps on this computer are exposed for remote access. While they
   * are, the local server keeps running whichever connection is chosen, until
   * the app quits. A running server changes without restarting, so nothing
   * reconnects; rejects when it cannot, such as when the port is taken.
   */
  setLocalExposure(exposure: LocalServerExposure | undefined): Promise<void> {
    return this.serialized(async () => {
      this.exposure = exposure;
      await this.options.localServer.setExposure(exposure);
      if (!this.started || this.disposed) return;
      // Turned off while a server is chosen: Wisps on this computer stop, as they did before.
      if (!exposure && this.status.profileId !== LOCAL_CONNECTION_ID) await this.options.localServer.stop();
      this.keepLocalServerRunning();
    });
  }

  view(): ConnectionsView {
    const { store } = this.options;
    return {
      activeId: store.active.id,
      profiles: store.list().map((profile) => ({
        ...profile,
        paired: profile.kind === "local" || Boolean(store.loadCredentials(profile.id)),
      })),
      status: {
        ...this.status,
        ...(this.progress ? { progress: structuredClone(this.progress) } : {}),
        ...(this.retrying ? { retry: structuredClone(this.retrying) } : {}),
      },
      secureStorageAvailable: store.secureStorageAvailable,
      ...(this.sshPrompts[0] ? { sshPrompt: this.sshPrompts[0].view } : {}),
    };
  }

  /**
   * Asks the person a question OpenSSH has while connecting. Resolves
   * undefined when they decline it, leave it unanswered too long, or the
   * connection that asked stops.
   */
  askSsh(prompt: Omit<SshPromptView, "id">, signal?: AbortSignal): Promise<string | undefined> {
    if (this.disposed || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = `ssh-${++this.sshPromptCount}`;
      const finish = (answer: string | undefined): void => {
        const index = this.sshPrompts.findIndex((pending) => pending.view.id === id);
        if (index < 0) return;
        this.sshPrompts.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", decline);
        this.publish();
        resolve(answer);
      };
      const decline = (): void => finish(undefined);
      const timer = setTimeout(decline, SSH_PROMPT_TIMEOUT_MS);
      signal?.addEventListener("abort", decline, { once: true });
      this.sshPrompts.push({ view: { id, ...prompt }, finish });
      // OpenSSH asks once it reached the host: signing in is what waits on the person.
      if (this.progress?.steps.some((step) => step.id === "reach" && step.state === "active")) {
        this.progress = advance(this.progress, "sign_in");
      }
      this.publish();
    });
  }

  /** Answers a question from `askSsh`; no answer declines it. */
  answerSshPrompt(request: unknown): ConnectionsView {
    const { id, answer } = (request ?? {}) as { id?: unknown; answer?: unknown };
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      throw new WispBackendError("invalid_request", "The question is invalid.");
    }
    if (answer !== undefined && (typeof answer !== "string" || answer.length > MAX_SSH_ANSWER)) {
      throw new WispBackendError("invalid_request", "The answer is invalid.");
    }
    this.sshPrompts.find((pending) => pending.view.id === id)?.finish(answer);
    return this.view();
  }

  /** Runs a renderer request on the active server. */
  async dispatch(channel: string, payload: unknown): Promise<BackendResult<unknown>> {
    const operation = OPERATIONS_BY_CHANNEL.get(channel);
    // A server on another computer cannot open this computer's file picker: the app does, and sends the files.
    if (
      this.session &&
      channel === WISP_IPC_CHANNELS.attachWorkspaceFiles &&
      this.status.profileId !== LOCAL_CONNECTION_ID
    ) {
      return this.attachFromThisComputer(this.session, payload);
    }
    if (this.session && operation) return this.session.call(operation, payload);
    return {
      ok: false,
      error: { code: "unavailable", message: "Wisp is switching connections. Try again.", retryable: true },
    };
  }

  private async attachFromThisComputer(session: RemoteSession, payload: unknown): Promise<BackendResult<unknown>> {
    const conversationId = (payload as { conversationId?: unknown } | null)?.conversationId;
    if (typeof conversationId !== "string" || !conversationId || conversationId.length > 128) {
      return invalidResult("The request is invalid.");
    }
    const files: Array<{ name: string; content: Blob }> = [];
    for (const file of await this.options.selectFiles()) {
      const name = path.basename(file);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return invalidResult(`${name} is not a readable file.`);
      files.push({ name, content: await openAsBlob(file) });
    }
    return session.attachFiles(conversationId, files);
  }

  activate(id: string, pairingCode?: string): Promise<ConnectionsView> {
    // Choosing a connection, even the same one, replaces a setup in progress.
    this.installation?.controller.abort();
    return this.serialized(async () => {
      if (!this.options.store.get(id)) throw new WispBackendError("not_found", "That connection no longer exists.");
      if (id === this.status.profileId && this.session) this.session.start(pairingCode);
      else await this.open(id, pairingCode, true);
      return this.view();
    });
  }

  /** Retries the active connection now. */
  retry(): Promise<ConnectionsView> {
    return this.serialized(async () => {
      if (this.session) this.session.start();
      else if (this.status.phase !== "choosing") await this.open(this.status.profileId, undefined, true);
      return this.view();
    });
  }

  /**
   * Stops connecting to the active connection, or setting it up. It then
   * shows as cancelled, and `retry` connects again.
   */
  cancel(): Promise<ConnectionsView> {
    if (this.installation?.profileId === this.status.profileId) this.installation.controller.abort();
    return this.serialized(async () => {
      const { phase, profileId, serverVersion } = this.status;
      if (this.session && (phase === "connecting" || phase === "reconnecting")) {
        await this.close();
        // Between attempts nothing runs: the last failed attempt stays on screen.
        if (this.progress?.steps.some(({ state }) => state === "active")) {
          this.progress = fail(this.progress, "cancelled");
        }
        this.retrying = undefined;
        this.setStatus({
          profileId,
          phase: "error",
          message: "Connecting was cancelled.",
          failure: "cancelled",
          ...(serverVersion ? { serverVersion } : {}),
        });
      }
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

  /**
   * Sets the server up on the machine behind an SSH connection, then connects
   * to it. The setup can take minutes, so it does not hold up other requests:
   * choosing a connection, removing this one, or `cancelInstall` cancels it.
   */
  async installServer(id: string): Promise<ConnectionsView> {
    if (this.installation) {
      throw new WispBackendError("invalid_request", "Wisp is already setting up a server. Wait for it, or cancel it.");
    }
    const installation = { profileId: id, controller: new AbortController() };
    this.installation = installation;
    const { signal } = installation.controller;
    try {
      const { profile, active } = await this.serialized(async () => {
        const profile = this.options.store.get(id);
        if (!profile) throw new WispBackendError("not_found", "That connection no longer exists.");
        if (profile.kind !== "ssh") {
          throw new WispBackendError("invalid_request", "Only a server reached over SSH can be set up from this app.");
        }
        if (signal.aborted) throw new WispBackendError("unavailable", "Setting up the server was cancelled.", true);
        const active = profile.id === this.status.profileId;
        // Reconnecting to a server that is being installed would only fail again.
        if (active) {
          // A server that answered before is updated; otherwise it is installed.
          const fromVersion = this.status.serverVersion;
          await this.close();
          this.retrying = undefined;
          this.progress = advance(
            createProgress(fromVersion ? "update" : "install", INSTALL_STEPS, fromVersion),
            "reach",
            `Connecting to ${profile.host} over SSH…`,
          );
          this.setStatus({
            profileId: id,
            phase: "connecting",
            message: `Setting up the Wisp server on ${profile.host}…`,
            installing: true,
          });
        }
        return { profile, active };
      });
      // Still the screen of this setup: nobody chose another connection meanwhile.
      const showing = (): boolean => active && !this.disposed && this.status.profileId === id && !this.session;
      let installedPort: number | undefined;
      try {
        installedPort = await this.options.installServer(
          profile,
          (message, step) => {
            if (showing() && !signal.aborted) {
              if (this.progress) this.progress = advance(this.progress, step, message);
              this.setStatus({ profileId: id, phase: "connecting", message, installing: true });
            }
          },
          signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "The server could not be set up.";
        this.options.logger.warn("server_install_failed", { profileId: id, cancelled: signal.aborted, message });
        if (showing()) {
          const failure: ConnectionFailure = signal.aborted
            ? "cancelled"
            : error instanceof TransportError
              ? (error.failure ?? "install")
              : "install";
          if (this.progress) this.progress = fail(this.progress, failure, { skipRest: true });
          const details = error instanceof TransportError ? error.details : undefined;
          this.setStatus({ profileId: id, phase: "error", message, failure, ...(details ? { details } : {}) });
        }
        throw new WispBackendError("unavailable", message, true);
      }
      this.options.logger.info("server_installed", { profileId: id });
      if (installedPort !== undefined) await this.recordServerPort(id, installedPort);
      return await this.serialized(async () => {
        if (signal.aborted) throw new WispBackendError("unavailable", "Setting up the server was cancelled.", true);
        // The setup's steps stay on screen while the app connects to the new server.
        const setup = showing() && this.progress && this.progress.kind !== "connect" ? this.progress : undefined;
        await this.open(id, undefined, true, setup);
        return this.view();
      });
    } finally {
      if (this.installation === installation) this.installation = undefined;
    }
  }

  /** Keeps the port the Wisp server on an SSH profile's machine listens on, as it reported. */
  private async recordServerPort(id: string, port: number): Promise<void> {
    const profile = this.options.store.get(id);
    if (profile?.kind !== "ssh" || profile.serverPort === port) return;
    this.options.logger.info("server_port_found", { profileId: id, from: profile.serverPort, port });
    await this.options.store.setServerPort(id, port);
    this.publish();
  }

  /** Stops a server setup in progress; the machine keeps what was already installed. */
  cancelInstall(): ConnectionsView {
    this.installation?.controller.abort();
    return this.view();
  }

  remove(id: string): Promise<ConnectionsView> {
    if (this.installation?.profileId === id) this.installation.controller.abort();
    return this.serialized(async () => {
      if (id === LOCAL_CONNECTION_ID) throw new WispBackendError("invalid_request", "This computer cannot be removed.");
      const active = id === this.status.profileId;
      await this.options.store.remove(id);
      if (active) await this.open(LOCAL_CONNECTION_ID, undefined, true);
      else this.publish();
      return this.view();
    });
  }

  /** Disconnects and stops the local server; Wisps on other servers keep running. */
  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.localRestart);
    this.installation?.controller.abort();
    for (const pending of [...this.sshPrompts]) pending.finish(undefined);
    return this.serialized(async () => {
      await this.close();
      await this.options.localServer.stop();
      await this.options.store.flush();
    });
  }

  private async open(
    id: string,
    pairingCode: string | undefined,
    userInitiated: boolean,
    setup?: ConnectionProgress,
  ): Promise<void> {
    await this.close();
    // Wisps on this computer run only while it is chosen, or while remote access is on.
    if (id !== LOCAL_CONNECTION_ID && !this.exposure) await this.options.localServer.stop();
    if (this.disposed) return;
    const { store } = this.options;
    const profile = store.get(id) ?? store.active;
    if (profile.id !== store.active.id || !store.hasChoice) await store.setActive(profile.id);
    this.openSession(profile, pairingCode, userInitiated, setup);
  }

  private openSession(
    profile: ConnectionProfile,
    pairingCode: string | undefined,
    userInitiated: boolean,
    setup?: ConnectionProgress,
  ): void {
    const { store, localServer } = this.options;
    const local = profile.kind === "local";
    // After a setup, its last step stands for the whole connection.
    const steps = (): ConnectionProgress =>
      setup
        ? advance(setup, "connect")
        : createProgress("connect", connectSteps(profile.kind, Boolean(store.loadCredentials(profile.id))));
    this.progress = steps();
    this.retrying = undefined;
    this.setStatus({
      profileId: profile.id,
      phase: "connecting",
      message: local ? "Starting Wisps on this computer…" : `Connecting to ${profile.name}…`,
    });
    let serverVersion: string | undefined;
    const session = new RemoteSession({
      serverName: local ? "Wisp on this computer" : profile.name,
      deviceName: this.options.deviceName,
      openTransport: async (signal) => {
        if (profile.kind === "ssh") {
          // Connecting may have found the server on another port since this session started.
          const current = store.get(profile.id);
          return this.options.openSshTunnel(current?.kind === "ssh" ? current : profile, signal, (port) =>
            this.recordServerPort(profile.id, port),
          );
        }
        if (profile.kind === "url") return directTransport(profile.url);
        const running = await localServer.ensureRunning();
        return {
          baseUrl: running.baseUrl,
          closed: running.exited,
          // The server outlives a dropped connection; `stop` ends it.
          close: () => undefined,
          requestPairingCode: async () => running.localPairingCode,
        };
      },
      credentials: {
        load: () => store.loadCredentials(profile.id),
        save: async (credentials) => {
          // The desktop app always pairs with bearer tokens, never cookies.
          await store.saveCredentials(profile.id, credentials as DeviceCredentials | undefined);
          if (this.session === session) this.publish();
        },
      },
      onStatus: (phase, message, failure) => {
        if (this.session !== session) return;
        const now = Date.now();
        if (phase === "connected") {
          this.progress = undefined;
          this.retrying = undefined;
        } else if (phase === "connecting" || phase === "reconnecting" || phase === "error") {
          // Only a failed attempt, or a dropped connection, reports these: the first status is set above.
          if (this.progress) this.progress = fail(this.progress, failure?.failure, { now });
          const dropped = this.status.phase === "connected" || this.status.phase === "local";
          if (phase === "error") this.retrying = undefined;
          else if (dropped) this.retrying = { since: now, attempt: 0, failures: [] };
          else if (message) this.retrying = failedAttempt(this.retrying, message, now);
        }
        this.setStatus({
          profileId: profile.id,
          phase: phaseOf(phase, local),
          ...(message ? { message } : {}),
          ...(failure?.failure ? { failure: failure.failure } : {}),
          ...(failure?.details ? { details: failure.details } : {}),
          ...(serverVersion ? { serverVersion } : {}),
        });
      },
      onStage: (stage) => {
        if (this.session !== session) return;
        if (stage === "transport") {
          // A new attempt starts over; the setup's steps stay done.
          this.progress = steps();
          if (this.retrying) this.retrying = { ...this.retrying, nextAttemptAt: undefined };
        }
        const progress = this.progress;
        if (!progress) return;
        if (progress.kind !== "connect") {
          if (stage === "transport") this.progress = advance(progress, "connect");
        } else if (stage === "transport") {
          const first = progress.steps[0];
          if (first) this.progress = advance(progress, first.id);
        } else if (stage === "pair") {
          // This app pairs with its own server by itself, as part of starting it.
          if (!local) this.progress = advance(progress, "pair", undefined, "server");
        } else if (stage === "server") this.progress = advance(progress, local ? "start_local" : "server");
        else this.progress = advance(progress, "load");
        this.publish();
      },
      onRetry: (_attempt, delayMs) => {
        if (this.session !== session) return;
        const now = Date.now();
        this.retrying = {
          since: this.retrying?.since ?? now,
          attempt: this.retrying?.attempt ?? 0,
          failures: this.retrying?.failures ?? [],
          nextAttemptAt: now + delayMs,
        };
        this.publish();
      },
      onServer: (server) => {
        if (!local) serverVersion = server.version;
      },
      onEvent: (type, payload) => {
        if (this.session === session && PUSHED.has(type)) {
          this.options.broadcast(WISP_IPC_CHANNELS[type], payload);
        }
      },
      // Only the local server asks for screen actions, and only of the app that
      // started it; any server may relay a sign-in through this app.
      onHostRequest: (request) =>
        local || REMOTE_HOST_REQUESTS.has(request.kind)
          ? this.options.onHostRequest(request)
          : Promise.resolve({ ok: false, message: "Not available." }),
      onReset: () => {
        if (this.session === session) this.setStatus({ ...this.status }, true);
      },
    });
    this.session = session;
    // This app pairs with its own server by itself; other servers only on request.
    session.start(pairingCode, local || userInitiated);
  }

  /** While remote access is on, starts the local server, and starts it again whenever it stops. */
  private keepLocalServerRunning(): void {
    if (!this.exposure || !this.started || this.disposed) return;
    clearTimeout(this.localRestart);
    this.options.localServer.ensureRunning().then(
      (running) => {
        if (this.watchedLocalExit === running.exited) return;
        this.watchedLocalExit = running.exited;
        void running.exited.then(() => this.restartLocalServer(LOCAL_RESTART_DELAY_MS));
      },
      (error: unknown) => {
        this.options.logger.warn("local_server_unavailable", {
          message: error instanceof Error ? error.message : "unknown",
        });
        this.restartLocalServer(LOCAL_RETRY_DELAY_MS);
      },
    );
  }

  private restartLocalServer(delayMs: number): void {
    if (!this.exposure || this.disposed) return;
    clearTimeout(this.localRestart);
    this.localRestart = setTimeout(() => this.keepLocalServerRunning(), delayMs);
    this.localRestart.unref?.();
  }

  private async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.stop();
    if (session) this.options.onSessionClosed?.();
  }

  private setStatus(next: Omit<ConnectionStatus, "epoch" | "progress" | "retry">, reset = false): void {
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

/** The local server is "this computer" to the renderer once connected. */
function phaseOf(phase: RemoteSessionPhase, local: boolean): ConnectionPhase {
  return local && phase === "connected" ? "local" : phase;
}

function directTransport(url: string): RemoteTransport {
  return { baseUrl: url, closed: new Promise(() => undefined), close: () => undefined };
}

function invalidResult(message: string): BackendResult<never> {
  return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}
