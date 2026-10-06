import type { BackendResult } from "../shared/contracts.js";
import type { DeviceCredentials, HostRequest, HostResponse, RemoteEventType } from "../shared/remote-protocol.js";
import { RemoteClient, RemoteError, type CredentialStore } from "./remote-client.js";

/** A path to the server, such as an SSH tunnel or a direct HTTPS origin. */
export interface RemoteTransport {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Resolves when the path is gone (the tunnel exited); a direct origin never closes. */
  closed: Promise<void>;
  close(): void;
  /** Asks the server for a pairing code over an already authenticated channel, such as SSH. */
  requestPairingCode?(): Promise<string>;
}

/** A transport failure that retrying cannot fix, such as an untrusted host key. */
export class FatalTransportError extends Error {
  override name = "FatalTransportError";
}

export type RemoteSessionPhase = "connecting" | "pairing_required" | "connected" | "reconnecting" | "error";

export interface RemoteSessionOptions {
  /** Shown in messages, e.g. "Home server". */
  serverName: string;
  deviceName: string;
  openTransport(signal: AbortSignal): Promise<RemoteTransport>;
  credentials: CredentialStore & { load(): StoredCredentials | undefined };
  onStatus(phase: RemoteSessionPhase, message?: string): void;
  onEvent(type: Exclude<RemoteEventType, "resync" | "hostRequest">, payload: unknown): void;
  /** Does what the server asked on this computer's screen; without it, every request is refused. */
  onHostRequest?(request: HostRequest): Promise<HostResponse>;
  /** Everything the client holds must be reloaded: first connection, or events were missed. */
  onReset(): void;
  /** Delay before reconnect attempt `attempt` (from 0). */
  backoffMs?: (attempt: number) => number;
}

export type StoredCredentials = DeviceCredentials;

const defaultBackoff = (attempt: number): number =>
  Math.min(30_000, 1_000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);

/**
 * Keeps one device connected to a Wisp server: opens the transport, pairs when
 * needed, follows the event stream, and reconnects with backoff. Calls made
 * while disconnected fail fast with `unavailable` instead of waiting.
 */
export class RemoteSession {
  private readonly controller = new AbortController();
  private client: RemoteClient | undefined;
  private transport: RemoteTransport | undefined;
  private cursor: string | undefined;
  private connected = false;
  private everConnected = false;
  private pairingCode: string | undefined;
  // Pairing over SSH happens only on a user's request: never silently after this device was revoked.
  private autoPair = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly options: RemoteSessionOptions) {}

  /**
   * Starts, or retries now. `autoPair` lets it ask the transport for a pairing
   * code when the device has none: pass true only for a user's request.
   */
  start(pairingCode?: string, autoPair = true): void {
    if (pairingCode !== undefined) this.pairingCode = pairingCode.trim();
    this.autoPair = autoPair;
    if (this.controller.signal.aborted) return;
    if (this.running) {
      this.wake?.();
      return;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
  }

  /** Disconnects; the server keeps running every Wisp. */
  async stop(): Promise<void> {
    this.controller.abort();
    this.wake?.();
    this.transport?.close();
    await this.running;
  }

  async call(operation: string, payload: unknown): Promise<BackendResult<unknown>> {
    const client = this.client;
    if (!client || !this.connected) return this.unavailable();
    try {
      return await client.call(operation, payload);
    } catch (error) {
      if (error instanceof RemoteError && error.code === "unauthorized") this.requirePairing();
      if (error instanceof RemoteError && error.code === "not_found") {
        return {
          ok: false,
          error: { code: "unsupported", message: "This server does not offer that action.", retryable: false },
        };
      }
      if (error instanceof RemoteError && error.code !== "network") {
        return { ok: false, error: { code: "unavailable", message: error.message, retryable: false } };
      }
      return this.unavailable();
    }
  }

  private unavailable(): BackendResult<never> {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: `${this.options.serverName} cannot be reached right now. Wisps on it keep working.`,
        retryable: true,
      },
    };
  }

  private async answer(client: RemoteClient, request: HostRequest): Promise<void> {
    let response: HostResponse;
    try {
      response = this.options.onHostRequest
        ? await this.options.onHostRequest(request)
        : { ok: false, message: "This app cannot do that." };
    } catch (error) {
      response = { ok: false, message: error instanceof Error ? error.message : "The app could not do that." };
    }
    // The server times the request out if this answer is lost.
    await client.answerHostRequest(request.id, response).catch(() => undefined);
  }

  private requirePairing(message = "This device needs to be paired with the server again."): void {
    this.connected = false;
    this.autoPair = false;
    this.options.onStatus("pairing_required", message);
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    let attempt = 0;
    while (!signal.aborted) {
      let waitForUser = false;
      try {
        if (!this.transport) {
          const opened = await this.options.openTransport(signal);
          // Stopped while the transport was opening: nothing else may start.
          if (signal.aborted) {
            opened.close();
            break;
          }
          this.transport = opened;
          // A tunnel that exits is reopened on the next attempt.
          void opened.closed.then(() => {
            if (this.transport === opened) this.transport = undefined;
          });
        }
        const transport = this.transport;
        const client = new RemoteClient({
          baseUrl: transport.baseUrl,
          credentials: this.options.credentials,
          ...(transport.fetch ? { fetch: transport.fetch } : {}),
        });
        this.client = client;
        if (!this.options.credentials.load()) {
          const code = this.pairingCode || (this.autoPair ? await transport.requestPairingCode?.() : undefined);
          this.pairingCode = undefined;
          if (!code) {
            this.requirePairing("Enter a pairing code from `wispctl pair` on the server.");
            waitForUser = true;
          } else {
            await client.pair(code, this.options.deviceName);
            // Paired again: nothing from before can be replayed.
            this.cursor = undefined;
          }
        }
        if (!waitForUser) {
          const pinned = this.options.credentials.load()?.serverId;
          const server = await client.describe();
          if (pinned && server.serverId !== pinned) {
            throw new FatalTransportError(
              "This is not the server this device paired with. Remove the connection and add it again.",
            );
          }
          await client.streamEvents(
            this.cursor,
            {
              onOpen: () => {
                attempt = 0;
                this.connected = true;
                this.options.onStatus("connected");
                if (!this.everConnected || this.cursor === undefined) {
                  this.everConnected = true;
                  this.options.onReset();
                }
              },
              onEvent: (id, type, payload) => {
                if (id) this.cursor = id;
                if (type === "resync") this.options.onReset();
                else if (type === "hostRequest") void this.answer(client, payload as HostRequest);
                else this.options.onEvent(type, payload);
              },
            },
            signal,
          );
          // The server ended the stream: it is shutting down or revoked this device.
          this.disconnected("The server closed the connection. Reconnecting…");
        }
      } catch (error) {
        if (signal.aborted) break;
        this.connected = false;
        if (error instanceof FatalTransportError) {
          this.options.onStatus("error", error.message);
          waitForUser = true;
        } else if (error instanceof RemoteError && error.code === "unauthorized") {
          this.requirePairing(
            this.everConnected
              ? undefined
              : "The pairing code was not accepted. Generate a new one with `wispctl pair`.",
          );
          waitForUser = true;
        } else {
          this.disconnected(error instanceof Error ? error.message : "The server cannot be reached.");
        }
      }
      if (signal.aborted) break;
      if (waitForUser) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
        attempt = 0;
        continue;
      }
      await this.sleep((this.options.backoffMs ?? defaultBackoff)(attempt++));
    }
    this.connected = false;
    this.transport?.close();
    this.transport = undefined;
  }

  private disconnected(message: string): void {
    this.connected = false;
    this.options.onStatus(this.everConnected ? "reconnecting" : "connecting", message);
  }

  /** Waits, or returns early when stopped or restarted. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).then(() => {
      this.wake = undefined;
    });
  }
}
