import { randomUUID } from "node:crypto";
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
  advance,
  connectSteps,
  createProgress,
  fail,
  failedAttempt,
  INSTALL_STEPS,
} from "../../shared/connection-progress.js";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionEventMessage,
  type ConnectionFailure,
  type ConnectionPhase,
  type ConnectionProfile,
  type ConnectionProgress,
  type ConnectionPushedEventType,
  type ConnectionRetry,
  type ConnectionStatus,
  type ConnectionsView,
  type EnvironmentSummary,
  type RemoteConnectionProfile,
  type ServerUpdateView,
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
import { isRuntimeOperation, type RuntimeOperation } from "../../shared/runtime-operations.js";
import { type ServerUpdateRecord, UNFINISHED_UPDATE_STATES } from "../../shared/server-update.js";
import type { LocalServer, LocalServerExposure } from "../local-server/local-server.js";
import { LOCAL_PROFILE, type ConnectionStore } from "./connection-store.js";
import { type InstallOutcome, type InstallStep, SetupOutcomeUnknownError } from "./ssh-install.js";

export interface ConnectionManagerOptions {
  store: ConnectionStore;
  /**
   * The Wisp server on this computer, kept running in the background once the
   * person has chosen where Wisps run, or while remote access is enabled.
   */
  localServer: LocalServer;
  /**
   * Opens a tunnel; `onServerPort` hears the port `wispctl status` reports when
   * it differs from the profile's. Background sessions pass `interactive: false`
   * so OpenSSH runs in BatchMode and never asks interactive prompts.
   */
  openSshTunnel(
    profile: SshConnectionProfile,
    signal: AbortSignal,
    onServerPort: (port: number) => Promise<void>,
    options?: { interactive?: boolean },
  ): Promise<RemoteTransport>;
  /**
   * Installs and starts the Wisp server on the machine behind an SSH profile,
   * naming the run `updateId` on the server; reports progress lines, and
   * resolves with the port and version the server runs.
   */
  installServer(
    profile: SshConnectionProfile,
    onProgress: (message: string, step: InstallStep) => void,
    signal: AbortSignal,
    updateId: string,
  ): Promise<InstallOutcome>;
  /** Reads how the setup run `updateId` ended on the server, without changing anything there. */
  readServerUpdate(profile: SshConnectionProfile, updateId: string): Promise<ServerUpdateRecord | undefined>;
  /** The version this app installs on a server. */
  appVersion: string;
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
}

// sshd gives up on a login after two minutes by default.
const SSH_PROMPT_TIMEOUT_MS = 120_000;
const MAX_SSH_ANSWER = 1024;
// While local persistence or remote access is on, a local server that stopped restarts after this delay.
const LOCAL_RESTART_DELAY_MS = 2_000;
const LOCAL_RETRY_DELAY_MS = 30_000;

const OPERATIONS_BY_CHANNEL = new Map<string, string>(
  Object.entries(WISP_IPC_CHANNELS).map(([operation, channel]) => [channel, operation]),
);
const PUSHED: ReadonlySet<string> = new Set<ConnectionPushedEventType>([
  "agentEvent",
  "conversationChanged",
  "wispsChanged",
  "mcpSettingsChanged",
  "pluginSettingsChanged",
  "scheduledMessagesChanged",
  "messageQueueChanged",
  "jobsChanged",
]);
interface ManagedSession {
  profile: ConnectionProfile;
  session: RemoteSession;
  connected: boolean;
  phase: ConnectionPhase;
  message?: string;
  serverVersion?: string;
  /** Whether this session was opened interactively for the active workspace. */
  interactive: boolean;
}

/**
 * Owns where the backend runs. The app is always a client: "This computer"
 * is a Wisp server the app starts as a child process, reached exactly like a
 * server over SSH or HTTPS. A session pool keeps the active environment and
 * polite background environments connected so switching is instant, summaries
 * stay live, and scoped runtime operations can target any connected environment.
 */
export class ConnectionManager {
  private activeId = LOCAL_CONNECTION_ID;
  private status: ConnectionStatus = { profileId: LOCAL_CONNECTION_ID, phase: "connecting", epoch: 0 };
  /** The steps of the active attempt in progress, or of the last one that failed. */
  private progress: ConnectionProgress | undefined;
  /** Automatic retries since the active connection failed or dropped. */
  private retrying: ConnectionRetry | undefined;
  /** Open sessions keyed by profile ID. */
  private readonly sessions = new Map<string, ManagedSession>();
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
  /** The last server update this app started, shown while its connection is the active one. */
  private update: { profileId: string; view: ServerUpdateView } | undefined;
  /** Profiles whose pending update is being checked, so one check runs at a time. */
  private checkingUpdates = new Set<string>();

  constructor(private readonly options: ConnectionManagerOptions) {}

  /**
   * Opens the connection chosen last time and quietly connects this computer
   * and other paired environments. On a first run nothing starts until the
   * person chooses this computer or a server.
   */
  start(): Promise<void> {
    return this.serialized(async () => {
      const { store } = this.options;
      this.started = true;
      if (!store.hasChoice) {
        this.activeId = LOCAL_CONNECTION_ID;
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
      if (!this.shouldKeepLocalRunning() && this.activeId !== LOCAL_CONNECTION_ID) {
        clearTimeout(this.localRestart);
        await this.closeSession(LOCAL_CONNECTION_ID);
        await this.options.localServer.stop();
        this.publish();
      } else {
        this.keepLocalServerRunning();
        if (this.shouldKeepLocalRunning() && this.options.store.hasChoice && !this.sessions.has(LOCAL_CONNECTION_ID)) {
          this.openPooledSession(LOCAL_PROFILE, { active: false, userInitiated: false });
          this.publish();
        }
      }
    });
  }

  /**
   * Requests connecting a saved environment in the background without changing
   * the active workspace. Background connections never auto-pair or prompt SSH.
   */
  connectEnvironment(id: string): Promise<ConnectionsView> {
    return this.serialized(async () => {
      const profile = this.options.store.get(id);
      if (!profile) throw new WispBackendError("not_found", "That connection no longer exists.");
      if (this.installation?.profileId === id) return this.view();
      if (id === this.activeId) {
        const active = this.sessions.get(id);
        if (active) {
          if (!active.connected) active.session.start();
        } else if (this.status.phase !== "choosing") {
          await this.open(id, undefined, true);
        }
        return this.view();
      }
      const existing = this.sessions.get(id);
      if (existing) {
        if (!existing.connected) existing.session.start(undefined, profile.kind === "local");
      } else {
        this.openPooledSession(profile, { active: false, userInitiated: false });
      }
      this.publish();
      return this.view();
    });
  }

  view(): ConnectionsView {
    const { store } = this.options;
    const profiles = store.list();
    const environments: Record<string, EnvironmentSummary> = {};
    for (const profile of profiles) {
      const managed = this.sessions.get(profile.id);
      if (managed) {
        environments[profile.id] = {
          profileId: profile.id,
          phase: managed.phase,
          ...(managed.message ? { message: managed.message } : {}),
          ...(managed.serverVersion ? { serverVersion: managed.serverVersion } : {}),
        };
      } else if (profile.id === this.status.profileId) {
        environments[profile.id] = {
          profileId: profile.id,
          phase: this.status.phase,
          ...(this.status.message ? { message: this.status.message } : {}),
          ...(this.status.serverVersion ? { serverVersion: this.status.serverVersion } : {}),
        };
      } else {
        const unpaired = profile.kind !== "local" && !store.loadCredentials(profile.id);
        environments[profile.id] = {
          profileId: profile.id,
          phase: unpaired ? "pairing_required" : "choosing",
        };
      }
    }
    return {
      activeId: store.active.id,
      profiles: profiles.map((profile) => ({
        ...profile,
        paired: profile.kind === "local" || Boolean(store.loadCredentials(profile.id)),
      })),
      status: {
        ...this.status,
        ...(this.progress ? { progress: structuredClone(this.progress) } : {}),
        ...(this.retrying ? { retry: structuredClone(this.retrying) } : {}),
        ...(this.update?.profileId === this.status.profileId ? { update: { ...this.update.view } } : {}),
      },
      secureStorageAvailable: store.secureStorageAvailable,
      environments,
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
    const active = this.sessions.get(this.activeId);
    if (active && operation && isRuntimeOperation(operation)) {
      return this.callSession(active, operation, payload);
    }
    return {
      ok: false,
      error: { code: "unavailable", message: "Wisp is switching connections. Try again.", retryable: true },
    };
  }

  /**
   * Runs one allowlisted runtime operation against a specific connected
   * environment in the session pool. Never accepts desktop-only channels or
   * arbitrary operation names.
   */
  async dispatchTo(connectionId: unknown, operation: unknown, payload: unknown): Promise<BackendResult<unknown>> {
    if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > 64) {
      return invalidResult("The connection is invalid.");
    }
    if (!isRuntimeOperation(operation)) {
      return invalidResult("The requested operation is not allowed.");
    }
    const profile = this.options.store.get(connectionId);
    if (!profile) {
      return {
        ok: false,
        error: { code: "not_found", message: "That connection no longer exists.", retryable: false },
      };
    }
    const managed = this.sessions.get(connectionId);
    if (!managed || !managed.connected) {
      return {
        ok: false,
        error: {
          code: "unavailable",
          message: `${profile.name} is not connected right now. Try again once it connects.`,
          retryable: true,
        },
      };
    }
    return this.callSession(managed, operation, payload);
  }

  private async callSession(
    managed: ManagedSession,
    operation: RuntimeOperation,
    payload: unknown,
  ): Promise<BackendResult<unknown>> {
    // A server on another computer cannot open this computer's file picker: the app does, and sends the files.
    return operation === "attachWorkspaceFiles" && managed.profile.id !== LOCAL_CONNECTION_ID
      ? this.attachFromThisComputer(managed.session, payload)
      : managed.session.call(operation, payload);
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
      const active = this.sessions.get(id);
      if (id === this.activeId && active && active.interactive) {
        active.session.start(pairingCode);
      } else {
        await this.open(id, pairingCode, true);
      }
      return this.view();
    });
  }

  /** This computer woke or changed network: every open connection checks it still works. */
  checkConnection(): void {
    for (const managed of this.sessions.values()) managed.session.check();
  }

  /** Retries the active connection now. */
  retry(): Promise<ConnectionsView> {
    return this.serialized(async () => {
      const active = this.sessions.get(this.activeId);
      if (active && active.interactive) active.session.start();
      else if (this.status.phase !== "choosing") await this.open(this.activeId, undefined, true);
      return this.view();
    });
  }

  /**
   * Stops connecting to the active connection, or setting it up. It then
   * shows as cancelled, and `retry` connects again.
   */
  cancel(): Promise<ConnectionsView> {
    if (this.installation?.profileId === this.activeId) this.installation.controller.abort();
    return this.serialized(async () => {
      const { phase, profileId, serverVersion } = this.status;
      if (this.sessions.has(profileId) && (phase === "connecting" || phase === "reconnecting")) {
        await this.closeSession(profileId, true);
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
      const requestedId = (request as { id?: unknown } | null)?.id;
      const before = typeof requestedId === "string" ? this.options.store.get(requestedId) : undefined;
      const profile = await this.options.store.save(request);
      if (profile.id === this.activeId) {
        // New settings for the active server take effect right away.
        await this.closeSession(profile.id, true);
        await this.open(profile.id, undefined, true);
      } else {
        const addressChanged =
          before !== undefined && before.kind !== "local" && addressOf(before) !== addressOf(profile);
        if (addressChanged) {
          await this.closeSession(profile.id);
        } else {
          const existing = this.sessions.get(profile.id);
          if (existing) existing.profile = profile;
        }
        if (
          this.options.store.hasChoice &&
          !this.sessions.has(profile.id) &&
          this.options.store.loadCredentials(profile.id)
        ) {
          this.openPooledSession(profile, { active: false, userInitiated: false });
        }
        this.publish();
      }
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
        const active = profile.id === this.activeId;
        // Stop any pooled session for this target so it does not fight the installer.
        await this.closeSession(id, active);
        if (active) {
          // A server that answered before is updated; otherwise it is installed.
          const fromVersion = this.status.serverVersion;
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
      const showing = (): boolean => active && !this.disposed && this.activeId === id && !this.sessions.has(id);
      // Recorded before the setup starts, so the app can ask how it ended even after a restart.
      const updateId = randomUUID();
      const { appVersion: targetVersion, store } = this.options;
      await store.setPendingUpdate(id, { id: updateId, targetVersion });
      this.setUpdate(id, { id: updateId, targetVersion, state: "running" });
      let outcome: InstallOutcome | undefined;
      try {
        try {
          outcome = await this.options.installServer(
            profile,
            (message, step) => {
              if (showing() && !signal.aborted) {
                if (this.progress) this.progress = advance(this.progress, step, message);
                this.setStatus({ profileId: id, phase: "connecting", message, installing: true });
              }
            },
            signal,
            updateId,
          );
        } catch (error) {
          if (signal.aborted || !(error instanceof TransportError)) throw error;
          if (!(error instanceof SetupOutcomeUnknownError)) {
            // A setup that failed on the server says how in its record, such as a rollback.
            if (error.failure !== "install") throw error;
            const record = await this.options.readServerUpdate(profile, updateId).catch(() => undefined);
            throw new SetupFailedError(error, record);
          }
          // The answer was lost, not necessarily the update: the server's record says how it went.
          const record = await this.options.readServerUpdate(profile, updateId).catch(() => undefined);
          if (record?.state !== "completed") throw new SetupFailedError(error, record);
          outcome = record.runningVersion ? { version: record.runningVersion } : {};
        }
      } catch (error) {
        const stillRunning = error instanceof SetupFailedError && error.stillRunning;
        const message = stillRunning
          ? `The update is still running on ${profile.host}. Wisp checks how it ended when it connects again.`
          : error instanceof Error
            ? error.message
            : "The server could not be set up.";
        this.options.logger.warn("server_install_failed", { profileId: id, cancelled: signal.aborted, message });
        if (stillRunning) {
          this.setUpdate(id, { id: updateId, targetVersion, state: "running", message });
        } else {
          await store.setPendingUpdate(id, undefined);
          if (signal.aborted) this.setUpdate(id, undefined);
          else {
            const recorded = error instanceof SetupFailedError ? error.record?.state : undefined;
            const state = recorded === "interrupted" || recorded === "rolled-back" ? recorded : "failed";
            this.setUpdate(id, { id: updateId, targetVersion, state, message });
          }
        }
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
      // Only the server's own version is left to confirm, once it answers.
      await store.setPendingUpdate(id, { id: updateId, targetVersion, setupCompleted: true });
      const installedPort = outcome.port;
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

  /**
   * Finds out how an update this app started on the server ended, after the
   * app reached the server (`runningVersion`) or failed to. It confirms the
   * update only when the server's record says it completed and the server
   * answers at the target version, so a reconnect alone confirms nothing.
   * It only reads: a failed update is reported, never run again by itself.
   */
  private async checkPendingUpdate(profile: SshConnectionProfile, runningVersion: string | undefined): Promise<void> {
    const { store } = this.options;
    const pending = store.pendingUpdate(profile.id);
    if (!pending || this.installation?.profileId === profile.id || this.checkingUpdates.has(profile.id)) return;
    // Unreachable after a setup that reported success: the connection's own error says enough.
    if (runningVersion === undefined && pending.setupCompleted) return;
    this.checkingUpdates.add(profile.id);
    try {
      const record = pending.setupCompleted
        ? undefined
        : await this.options.readServerUpdate(profile, pending.id).catch(() => undefined);
      if (store.pendingUpdate(profile.id)?.id !== pending.id || this.installation?.profileId === profile.id) return;
      const base = { id: pending.id, targetVersion: pending.targetVersion };
      if (record && UNFINISHED_UPDATE_STATES.has(record.state)) {
        this.setUpdate(profile.id, {
          ...base,
          state: "running",
          message: `The update to ${pending.targetVersion} is still running on ${profile.host}.`,
        });
        return;
      }
      let view: ServerUpdateView;
      if (record && record.state !== "completed") {
        view = {
          ...base,
          state: record.state === "interrupted" || record.state === "rolled-back" ? record.state : "failed",
          message: record.error ?? "The update did not finish.",
        };
      } else if (runningVersion === undefined) {
        // Completed, or unknown to the server: only answering at the right version tells.
        return;
      } else if (runningVersion === pending.targetVersion) {
        view = { ...base, state: "confirmed" };
      } else {
        view = {
          ...base,
          state: "failed",
          message: `${profile.name} still runs Wisp server ${runningVersion}, not ${pending.targetVersion}.`,
        };
      }
      await store.setPendingUpdate(profile.id, undefined);
      this.options.logger.info("server_update_checked", { profileId: profile.id, state: view.state });
      this.setUpdate(profile.id, view);
    } finally {
      this.checkingUpdates.delete(profile.id);
    }
  }

  private setUpdate(profileId: string, view: ServerUpdateView | undefined): void {
    this.update = view ? { profileId, view } : undefined;
    this.publish();
  }

  /** Keeps the port the Wisp server on an SSH profile's machine listens on, as it reported. */
  private async recordServerPort(id: string, port: number): Promise<void> {
    const profile = this.options.store.get(id);
    if (profile?.kind !== "ssh" || profile.serverPort === port) return;
    this.options.logger.info("server_port_found", { profileId: id, from: profile.serverPort, port });
    await this.options.store.setServerPort(id, port);
    const managed = this.sessions.get(id);
    if (managed) {
      const updated = this.options.store.get(id);
      if (updated) managed.profile = updated;
    }
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
      const active = id === this.activeId;
      await this.options.store.remove(id);
      await this.closeSession(id, active);
      if (active) await this.open(LOCAL_CONNECTION_ID, undefined, true);
      else this.publish();
      return this.view();
    });
  }

  /** Disconnects every pooled session and stops the local server; Wisps on other servers keep running. */
  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.localRestart);
    this.installation?.controller.abort();
    this.declineAllSshPrompts();
    return this.serialized(async () => {
      await this.closeAllSessions();
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
    if (this.disposed) return;
    const { store } = this.options;
    const profile = store.get(id) ?? store.active;
    const previousId = this.activeId;
    const switching = previousId !== profile.id;
    if (profile.id !== store.active.id || !store.hasChoice) await store.setActive(profile.id);

    if (switching) {
      this.declineAllSshPrompts();
      const previous = this.sessions.get(previousId);
      if (previous) {
        this.options.onSessionClosed?.();
        if (previousId === LOCAL_CONNECTION_ID && !this.shouldKeepLocalRunning()) {
          await this.closeSession(LOCAL_CONNECTION_ID);
          await this.options.localServer.stop();
        } else if (!previous.connected && (previous.phase !== "reconnecting" || !this.isPaired(previous.profile))) {
          // Do not leave an unfinished interactive attempt or unpaired session running in background.
          await this.closeSession(previousId);
        }
      } else if (previousId === LOCAL_CONNECTION_ID && !this.shouldKeepLocalRunning()) {
        await this.options.localServer.stop();
      }
    } else if (profile.id !== LOCAL_CONNECTION_ID && !this.shouldKeepLocalRunning()) {
      await this.options.localServer.stop();
    }

    if (this.disposed) return;

    const existing = this.sessions.get(profile.id);
    if (existing && existing.connected && !setup && pairingCode === undefined) {
      // Already connected in the pool: promote instantaneously without reopening transport.
      existing.interactive = true;
      this.activeId = profile.id;
      this.progress = undefined;
      this.retrying = undefined;
      this.setStatus(
        {
          profileId: profile.id,
          phase: existing.phase,
          ...(existing.message ? { message: existing.message } : {}),
          ...(existing.serverVersion ? { serverVersion: existing.serverVersion } : {}),
        },
        switching,
      );
      this.connectBackgroundProfiles();
      this.keepLocalServerRunning();
      return;
    }

    if (existing) {
      await this.closeSession(profile.id, !switching);
    }
    if (this.disposed) return;

    this.activeId = profile.id;
    this.openPooledSession(profile, { active: true, pairingCode, userInitiated, setup });
    this.connectBackgroundProfiles();
    this.keepLocalServerRunning();
  }

  /**
   * Quietly starts background sessions for already-paired remote servers and
   * for `local`, so every environment's conversations stay live.
   */
  private connectBackgroundProfiles(): void {
    const { store } = this.options;
    if (!store.hasChoice || this.disposed) return;
    for (const profile of store.list()) {
      if (profile.id === this.activeId) continue;
      if (this.sessions.has(profile.id)) continue;
      if (this.installation?.profileId === profile.id) continue;
      if (profile.kind === "local") {
        if (!this.shouldKeepLocalRunning()) continue;
      } else if (!store.loadCredentials(profile.id)) {
        continue;
      }
      this.openPooledSession(profile, { active: false, userInitiated: false });
    }
  }

  private openPooledSession(
    profile: ConnectionProfile,
    options: {
      active: boolean;
      pairingCode?: string;
      userInitiated: boolean;
      setup?: ConnectionProgress;
    },
  ): void {
    const { store, localServer } = this.options;
    const local = profile.kind === "local";
    const initialMessage = local ? "Starting Wisps on this computer…" : `Connecting to ${profile.name}…`;
    // After a setup, its last step stands for the whole connection.
    const steps = (): ConnectionProgress =>
      options.setup
        ? advance(options.setup, "connect")
        : createProgress("connect", connectSteps(profile.kind, Boolean(store.loadCredentials(profile.id))));

    let managed!: ManagedSession;

    const session = new RemoteSession({
      serverName: local ? "Wisp on this computer" : profile.name,
      deviceName: this.options.deviceName,
      openTransport: async (signal) => {
        if (profile.kind === "ssh") {
          // Connecting may have found the server on another port since this session started.
          const current = store.get(profile.id);
          const sshProfile = current?.kind === "ssh" ? current : profile;
          // Background sessions must never pop up interactive OpenSSH prompts.
          const interactive = this.activeId === profile.id;
          return this.options.openSshTunnel(sshProfile, signal, (port) => this.recordServerPort(profile.id, port), {
            interactive,
          });
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
          if (this.sessions.get(profile.id) === managed) this.publish();
        },
      },
      onStatus: (phase, message, failure) => {
        if (this.sessions.get(profile.id) !== managed) return;
        const mappedPhase = phaseOf(phase, local);
        const wasConnected = managed.connected;
        const summaryChanged = managed.phase !== mappedPhase || managed.message !== message;
        managed.connected = phase === "connected";
        managed.phase = mappedPhase;
        managed.message = message;

        if (this.activeId === profile.id) {
          const now = Date.now();
          if (phase === "connected") {
            this.progress = undefined;
            this.retrying = undefined;
          } else if (phase === "connecting" || phase === "reconnecting" || phase === "error") {
            // A server that does not come back after an update may have failed it.
            if (profile.kind === "ssh" && failure) void this.checkPendingUpdate(profile, undefined);
            // Only a failed attempt, or a dropped connection, reports these: the first status is set below.
            if (this.progress) this.progress = fail(this.progress, failure?.failure, { now });
            const dropped = wasConnected || this.status.phase === "connected" || this.status.phase === "local";
            if (phase === "error") this.retrying = undefined;
            else if (dropped) this.retrying = { since: now, attempt: 0, failures: [] };
            else if (message) this.retrying = failedAttempt(this.retrying, message, now);
          }
          this.setStatus({
            profileId: profile.id,
            phase: mappedPhase,
            ...(message ? { message } : {}),
            ...(failure?.failure ? { failure: failure.failure } : {}),
            ...(failure?.details ? { details: failure.details } : {}),
            ...(managed.serverVersion ? { serverVersion: managed.serverVersion } : {}),
          });
        } else if (summaryChanged) {
          this.publish();
        }
      },
      onStage: (stage) => {
        if (this.sessions.get(profile.id) !== managed || this.activeId !== profile.id) return;
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
        if (this.sessions.get(profile.id) !== managed || this.activeId !== profile.id) return;
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
        if (this.sessions.get(profile.id) !== managed) return;
        if (local) return;
        const changed = managed.serverVersion !== server.version;
        managed.serverVersion = server.version;
        if (this.activeId === profile.id) {
          if (profile.kind === "ssh") void this.checkPendingUpdate(profile, server.version);
        } else if (changed) {
          this.publish();
        }
      },
      onEvent: (type, payload) => {
        if (this.sessions.get(profile.id) !== managed) return;
        if (!PUSHED.has(type)) return;
        const eventType = type as ConnectionPushedEventType;
        if (this.activeId === profile.id) {
          this.options.broadcast(WISP_IPC_CHANNELS[eventType], payload);
        }
        const scoped: ConnectionEventMessage = { connectionId: profile.id, type: eventType, payload };
        this.options.broadcast(WISP_IPC_CHANNELS.connectionEvent, scoped);
      },
      // Only the local server asks for screen actions, and only of the app that
      // started it; any server may relay a sign-in through this app.
      onHostRequest: (request) =>
        local || REMOTE_HOST_REQUESTS.has(request.kind)
          ? this.options.onHostRequest(request)
          : Promise.resolve({ ok: false, message: "Not available." }),
      onReset: () => {
        if (this.sessions.get(profile.id) !== managed) return;
        if (this.activeId === profile.id) {
          this.setStatus({ ...this.status }, true);
        }
      },
    });

    managed = {
      profile,
      session,
      connected: false,
      phase: "connecting",
      message: initialMessage,
      interactive: options.active,
    };
    this.sessions.set(profile.id, managed);

    if (options.active) {
      this.progress = steps();
      this.retrying = undefined;
      this.setStatus({
        profileId: profile.id,
        phase: "connecting",
        message: initialMessage,
      });
    }

    // This app pairs with its own server by itself; other servers only on explicit active user request.
    session.start(options.pairingCode, local || (options.active && options.userInitiated));
  }

  /** The local server runs from the first choice of where Wisps run, or earlier while remote access needs it. */
  private shouldKeepLocalRunning(): boolean {
    return Boolean(this.exposure) || this.options.store.hasChoice;
  }

  private isPaired(profile: ConnectionProfile): boolean {
    return profile.kind === "local" || Boolean(this.options.store.loadCredentials(profile.id));
  }

  /** Starts the local server and restarts it if it stops, while it should keep running. */
  private keepLocalServerRunning(): void {
    if (!this.shouldKeepLocalRunning() || !this.started || this.disposed) return;
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
    if (!this.shouldKeepLocalRunning() || this.disposed) return;
    clearTimeout(this.localRestart);
    this.localRestart = setTimeout(() => this.keepLocalServerRunning(), delayMs);
    this.localRestart.unref?.();
  }

  private declineAllSshPrompts(): void {
    for (const pending of [...this.sshPrompts]) pending.finish(undefined);
  }

  private async closeSession(id: string, notifyClosed = false): Promise<void> {
    const managed = this.sessions.get(id);
    if (!managed) return;
    this.sessions.delete(id);
    await managed.session.stop();
    if (notifyClosed) this.options.onSessionClosed?.();
  }

  private async closeAllSessions(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(open.map((managed) => managed.session.stop()));
    if (open.length > 0) this.options.onSessionClosed?.();
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

function addressOf(profile: RemoteConnectionProfile): string {
  return profile.kind === "ssh"
    ? `${profile.user ?? ""}@${profile.host}:${profile.sshPort ?? ""}:${profile.serverPort}`
    : profile.url;
}

/** A setup that did not complete, with the server's record of it when it could be read. */
class SetupFailedError extends TransportError {
  readonly stillRunning: boolean;

  constructor(
    failure: TransportError,
    readonly record: ServerUpdateRecord | undefined,
  ) {
    super(record?.error ?? failure.message, failure.failure ?? "install", failure.details);
    this.stillRunning = record !== undefined && UNFINISHED_UPDATE_STATES.has(record.state);
  }
}
