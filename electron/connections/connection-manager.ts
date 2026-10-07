import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { WispBackendError } from "../../backend/backend-error.js";
import type { StructuredLogger } from "../../backend/structured-logger.js";
import { RemoteSession, type RemoteSessionPhase, type RemoteTransport } from "../../client/remote-session.js";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionPhase,
  type ConnectionProfile,
  type ConnectionStatus,
  type ConnectionsView,
  type SshConnectionProfile,
  type SshPrompt,
  type SshQuestion,
  type SshServerCheck,
} from "../../shared/connections.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { DeviceCredentials, HostRequest, HostResponse } from "../../shared/remote-protocol.js";
import type { LocalServer } from "../local-server/local-server.js";
import type { ConnectionStore } from "./connection-store.js";

export interface ConnectionManagerOptions {
  store: ConnectionStore;
  /** The Wisp server on this computer, started only while it is the chosen connection. */
  localServer: LocalServer;
  openSshTunnel(profile: SshConnectionProfile, signal: AbortSignal): Promise<RemoteTransport>;
  /** Installs and starts the Wisp server on the machine behind an SSH profile; reports progress lines. */
  installServer(
    profile: SshConnectionProfile,
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ): Promise<{ warnings: string[] } | void>;
  /** Keeps a server's Wisps running after logout there, asking for a sudo password through `askSsh` if needed. */
  enableLinger(
    profile: SshConnectionProfile,
    askPassword: () => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Connects to an SSH server once, asking through `askSsh` about an unknown
   * host key or a password, so later connections need no questions.
   */
  checkSshServer(
    profile: SshConnectionProfile,
    signal: AbortSignal,
    onBrowserCheck: (url: string) => void,
  ): Promise<{ installedVersion?: string; addedKey: boolean }>;
  /** This app's version; installing sets up the same server version. */
  appVersion: string;
  /** Does what the local server asks on this computer's screen. */
  onHostRequest(request: HostRequest): Promise<HostResponse>;
  /** Shows a native multi-file picker; resolves with absolute paths, empty when dismissed. */
  selectFiles(): Promise<ReadonlyArray<string>>;
  deviceName: string;
  /** Sends a push channel payload to every renderer window. */
  broadcast(channel: string, payload: unknown): void;
  logger: Pick<StructuredLogger, "info" | "warn">;
  /** Whether this computer already has Wisps from a version that had no connection choice. */
  hasLocalData(): Promise<boolean>;
}

/** A server setup in progress, with its latest progress line. */
interface Installation {
  profileId: string;
  controller: AbortController;
  message?: string;
}

const OPERATIONS_BY_CHANNEL = new Map<string, string>(
  Object.entries(WISP_IPC_CHANNELS).map(([operation, channel]) => [channel, operation]),
);
const PUSHED = new Set(["agentEvent", "conversationChanged", "mcpSettingsChanged"]);

/**
 * Owns where the backend runs. The app is always a client: "This computer"
 * is a Wisp server the app starts as a child process, reached exactly like a
 * server over SSH or HTTPS. Renderer requests go to the active session, and
 * only its events reach the renderer.
 */
export class ConnectionManager {
  private status: ConnectionStatus = { profileId: LOCAL_CONNECTION_ID, phase: "connecting", epoch: 0 };
  private session: RemoteSession | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private installation: Installation | undefined;
  private sshCheck: { profileId: string; controller: AbortController } | undefined;
  private prompt: { view: SshPrompt; resolve: (answer: string | undefined) => void } | undefined;
  private promptId = 0;
  /** Servers whose setup could not turn on linger, until it is turned on from here. */
  private lingerNeeded = new Set<string>();

  constructor(private readonly options: ConnectionManagerOptions) {}

  /**
   * Opens the connection chosen last time. On a first run nothing starts:
   * the person chooses this computer or a server first. People upgrading
   * with Wisps already on this computer keep using it.
   */
  start(): Promise<void> {
    return this.serialized(async () => {
      const { store } = this.options;
      if (!store.hasChoice && !(await this.options.hasLocalData())) {
        this.setStatus({ profileId: LOCAL_CONNECTION_ID, phase: "choosing" });
        return;
      }
      await this.open(store.active.id, undefined, false);
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
      status: { ...this.status },
      secureStorageAvailable: store.secureStorageAvailable,
      ...(this.prompt ? { sshPrompt: this.prompt.view } : {}),
      ...(this.lingerNeeded.size > 0 ? { lingerNeeded: [...this.lingerNeeded] } : {}),
      ...(this.installation
        ? {
            installation: {
              profileId: this.installation.profileId,
              ...(this.installation.message ? { message: this.installation.message } : {}),
            },
          }
        : {}),
    };
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
    const installation: Installation = { profileId: id, controller: new AbortController() };
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
          await this.close();
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
      let warnings: string[] = [];
      try {
        const result = await this.options.installServer(
          profile,
          (message) => {
            if (this.installation === installation && !signal.aborted) {
              installation.message = message;
              if (!showing()) this.publish();
            }
            if (showing() && !signal.aborted) {
              this.setStatus({ profileId: id, phase: "connecting", message, installing: true });
            }
          },
          signal,
        );
        warnings = result?.warnings ?? [];
      } catch (error) {
        const message = error instanceof Error ? error.message : "The server could not be set up.";
        this.options.logger.warn("server_install_failed", { profileId: id, cancelled: signal.aborted });
        if (showing()) this.setStatus({ profileId: id, phase: "error", message });
        throw new WispBackendError("unavailable", message, true);
      }
      this.options.logger.info("server_installed", { profileId: id });
      if (warnings.some((warning) => /enable-linger/.test(warning))) this.lingerNeeded.add(id);
      else this.lingerNeeded.delete(id);
      return await this.serialized(async () => {
        if (signal.aborted) throw new WispBackendError("unavailable", "Setting up the server was cancelled.", true);
        await this.open(id, undefined, true);
        return this.view();
      });
    } finally {
      if (this.installation === installation) {
        this.installation = undefined;
        this.publish();
      }
    }
  }

  /**
   * Connects to an SSH server as the person, answering OpenSSH's questions
   * in the app, and makes sure later connections need none. Like a setup, it
   * runs beside other requests; `cancelSshCheck` or removing the connection
   * stops it.
   */
  async checkSsh(id: string): Promise<SshServerCheck> {
    const profile = this.options.store.get(id);
    if (!profile) throw new WispBackendError("not_found", "That connection no longer exists.");
    if (profile.kind !== "ssh") throw new WispBackendError("invalid_request", "Only an SSH connection can be checked.");
    if (this.sshCheck) {
      throw new WispBackendError(
        "invalid_request",
        "Wisp is already checking a connection. Wait for it, or cancel it.",
      );
    }
    const check = { profileId: id, controller: new AbortController() };
    this.sshCheck = check;
    try {
      const result = await this.options.checkSshServer(profile, check.controller.signal, (url) =>
        this.showBrowserCheck(url, profile.host),
      );
      this.options.logger.info("ssh_checked", { profileId: id, addedKey: result.addedKey });
      return { ...result, appVersion: this.options.appVersion };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The connection could not be checked.";
      this.options.logger.warn("ssh_check_failed", { profileId: id, cancelled: check.controller.signal.aborted });
      throw new WispBackendError("unavailable", message, true);
    } finally {
      if (this.sshCheck === check) this.sshCheck = undefined;
      this.dismissPrompt();
    }
  }

  /**
   * Turns on linger on a server, so its Wisps keep running after the person
   * logs out there. Runs like a check: one at a time, cancellable, and may
   * ask for a sudo password.
   */
  async enableLinger(id: string): Promise<ConnectionsView> {
    const profile = this.options.store.get(id);
    if (!profile) throw new WispBackendError("not_found", "That connection no longer exists.");
    if (profile.kind !== "ssh") throw new WispBackendError("invalid_request", "Only an SSH connection can be changed.");
    if (this.sshCheck) {
      throw new WispBackendError(
        "invalid_request",
        "Wisp is already checking a connection. Wait for it, or cancel it.",
      );
    }
    const check = { profileId: id, controller: new AbortController() };
    this.sshCheck = check;
    try {
      await this.options.enableLinger(
        profile,
        () => this.askSsh({ kind: "secret", message: `Password for sudo on ${profile.host}:` }),
        check.controller.signal,
      );
      this.lingerNeeded.delete(id);
      this.options.logger.info("linger_enabled", { profileId: id });
      return this.view();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Linger could not be turned on.";
      throw new WispBackendError("unavailable", message, true);
    } finally {
      if (this.sshCheck === check) this.sshCheck = undefined;
      this.dismissPrompt();
    }
  }

  /** Tailscale SSH waits for an approval in the browser; the page is shown until the check goes on. */
  private showBrowserCheck(url: string, host: string): void {
    if (!this.sshCheck || this.disposed || !/^https:\/\//.test(url)) return;
    this.dismissPrompt();
    this.prompt = {
      view: {
        id: ++this.promptId,
        kind: "browser",
        url,
        message: `Tailscale asks you to approve this connection to ${host} in your browser.`,
      },
      resolve: () => undefined,
    };
    this.publish();
  }

  cancelSshCheck(): ConnectionsView {
    this.sshCheck?.controller.abort();
    this.dismissPrompt();
    return this.view();
  }

  /** Shows a question from OpenSSH until the person answers it. Only a check the person started may ask. */
  askSsh(prompt: SshQuestion): Promise<string | undefined> {
    if (!this.sshCheck || this.disposed) return Promise.resolve(undefined);
    this.dismissPrompt();
    return new Promise((resolve) => {
      this.prompt = { view: { ...prompt, id: ++this.promptId } as SshPrompt, resolve };
      this.publish();
    });
  }

  /**
   * Answers the question shown now; an answer to an older one is ignored.
   * No answer cancels the check: OpenSSH would only ask the same again.
   */
  answerSshPrompt(id: number, answer: string | undefined): ConnectionsView {
    const prompt = this.prompt;
    if (prompt?.view.id !== id) return this.view();
    if (answer === undefined) return this.cancelSshCheck();
    this.prompt = undefined;
    // OpenSSH wants "yes" to trust a host key; a confirmation is accepted by any answer.
    prompt.resolve(prompt.view.kind === "confirm" ? "" : answer);
    this.publish();
    return this.view();
  }

  private dismissPrompt(): void {
    const prompt = this.prompt;
    if (!prompt) return;
    this.prompt = undefined;
    prompt.resolve(undefined);
    this.publish();
  }

  /** Stops a server setup in progress; the machine keeps what was already installed. */
  cancelInstall(): ConnectionsView {
    this.installation?.controller.abort();
    return this.view();
  }

  remove(id: string): Promise<ConnectionsView> {
    if (this.installation?.profileId === id) this.installation.controller.abort();
    if (this.sshCheck?.profileId === id) this.cancelSshCheck();
    this.lingerNeeded.delete(id);
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
    this.installation?.controller.abort();
    this.cancelSshCheck();
    return this.serialized(async () => {
      await this.close();
      await this.options.localServer.stop();
      await this.options.store.flush();
    });
  }

  private async open(id: string, pairingCode: string | undefined, userInitiated: boolean): Promise<void> {
    await this.close();
    // Wisps on this computer run only while it is chosen.
    if (id !== LOCAL_CONNECTION_ID) await this.options.localServer.stop();
    if (this.disposed) return;
    const { store } = this.options;
    const profile = store.get(id) ?? store.active;
    if (profile.id !== store.active.id || !store.hasChoice) await store.setActive(profile.id);
    this.openSession(profile, pairingCode, userInitiated);
  }

  private openSession(profile: ConnectionProfile, pairingCode: string | undefined, userInitiated: boolean): void {
    const { store, localServer } = this.options;
    const local = profile.kind === "local";
    this.setStatus({
      profileId: profile.id,
      phase: "connecting",
      message: local ? "Starting Wisps on this computer…" : `Connecting to ${profile.name}…`,
    });
    const session = new RemoteSession({
      serverName: local ? "Wisp on this computer" : profile.name,
      deviceName: this.options.deviceName,
      openTransport: async (signal) => {
        if (profile.kind === "ssh") return this.options.openSshTunnel(profile, signal);
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
      onStatus: (phase, message) => {
        if (this.session !== session) return;
        this.setStatus({ profileId: profile.id, phase: phaseOf(phase, local), ...(message ? { message } : {}) });
      },
      onEvent: (type, payload) => {
        if (this.session === session && PUSHED.has(type)) {
          this.options.broadcast(WISP_IPC_CHANNELS[type], payload);
        }
      },
      // Only the local server sends these, and only to the app that started it.
      onHostRequest: (request) =>
        local ? this.options.onHostRequest(request) : Promise.resolve({ ok: false, message: "Not available." }),
      onReset: () => {
        if (this.session === session) this.setStatus({ ...this.status }, true);
      },
    });
    this.session = session;
    // This app pairs with its own server by itself; other servers only on request.
    session.start(pairingCode, local || userInitiated);
  }

  private async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.stop();
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
