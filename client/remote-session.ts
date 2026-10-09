import type { BackendResult } from "../shared/contracts.js";
import {
  REMOTE_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type RemoteEventType,
  type ServerDescriptor,
} from "../shared/remote-protocol.js";
import {
  MAX_ATTACHMENTS_PER_REQUEST,
  formatBytes,
  type AttachWorkspaceFilesResult,
  type WorkspaceAttachment,
  type WorkspaceView,
} from "../shared/workspace.js";
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
  /** A clearer reason for the last failure to reach the server, when the transport knows one. */
  explainFailure?(): string | undefined;
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
  credentials: CredentialStore;
  /** Authenticate with HttpOnly cookies, as the browser app does. */
  cookies?: boolean;
  onStatus(phase: RemoteSessionPhase, message?: string): void;
  /** Called with the server's description on every connection, before its status. */
  onServer?(server: ServerDescriptor): void;
  onEvent(type: Exclude<RemoteEventType, "resync" | "hostRequest">, payload: unknown): void;
  /** Does what the server asked on this computer's screen; without it, every request is refused. */
  onHostRequest?(request: HostRequest): Promise<HostResponse>;
  /** Everything the client holds must be reloaded: first connection, or events were missed. */
  onReset(): void;
  /** Delay before reconnect attempt `attempt` (from 0). */
  backoffMs?: (attempt: number) => number;
}

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
      return this.failureOf(error, "This server does not offer that action.");
    }
  }

  /**
   * Sends files from this device into a Wisp's workspace inbox, one request
   * per file, and answers like `attachWorkspaceFiles` does for a local picker.
   */
  async attachFiles(
    conversationId: string,
    files: ReadonlyArray<{ name: string; content: Blob }>,
  ): Promise<BackendResult<AttachWorkspaceFilesResult>> {
    const workspace = async (): Promise<BackendResult<WorkspaceView>> =>
      (await this.call("getWorkspace", { conversationId })) as BackendResult<WorkspaceView>;
    const before = await workspace();
    if (!before.ok || !files.length)
      return before.ok ? { ok: true, value: { files: [], workspace: before.value } } : before;
    if (files.length > MAX_ATTACHMENTS_PER_REQUEST) {
      return invalid(`Attach at most ${MAX_ATTACHMENTS_PER_REQUEST} files at a time.`);
    }
    // Checked here too, so a full workspace fails before any bytes are sent.
    const { usedBytes, quotaBytes } = before.value;
    if (usedBytes + files.reduce((sum, file) => sum + file.content.size, 0) > quotaBytes) {
      return invalid(
        `This Wisp's workspace is full (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used). Free some space before adding more files.`,
      );
    }
    const client = this.client;
    if (!client || !this.connected) return this.unavailable();
    const attached: WorkspaceAttachment[] = [];
    for (const file of files) {
      let result: BackendResult<WorkspaceAttachment>;
      try {
        result = await client.uploadWorkspaceFile(conversationId, file.name, file.content);
      } catch (error) {
        return this.failureOf(error, "This server cannot receive files. Update it to attach files from this device.");
      }
      if (!result.ok) return result;
      attached.push(result.value);
    }
    const after = await workspace();
    return after.ok ? { ok: true, value: { files: attached, workspace: after.value } } : after;
  }

  /** The result for a request the server never answered with an operation result. */
  private failureOf(error: unknown, notOffered: string): BackendResult<never> {
    if (error instanceof RemoteError && error.code === "unauthorized") this.requirePairing();
    if (error instanceof RemoteError && error.code === "not_found") {
      return { ok: false, error: { code: "unsupported", message: notOffered, retryable: false } };
    }
    if (error instanceof RemoteError && error.code !== "network") {
      return { ok: false, error: { code: "unavailable", message: error.message, retryable: false } };
    }
    return this.unavailable();
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

  /** Ends this device's access to the server; it must pair again to come back. */
  async signOut(): Promise<void> {
    const client = this.client;
    if (client && this.connected) await client.signOut().catch(() => undefined);
    await this.options.credentials.save(undefined);
    this.cursor = undefined;
    this.requirePairing("Signed out. Enter a pairing code from `wispctl pair` to use this server again.");
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
          signal,
          ...(this.options.cookies ? { cookies: true } : {}),
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
          this.options.onServer?.(server);
          const mismatch = protocolMismatch(this.options.serverName, server);
          if (mismatch) throw new FatalTransportError(mismatch);
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
          this.disconnected(
            this.transport?.explainFailure?.() ??
              (error instanceof Error ? error.message : "The server cannot be reached."),
          );
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

/** Why this app cannot talk to the server, when their protocols differ. */
function protocolMismatch(serverName: string, server: ServerDescriptor): string | undefined {
  if (server.protocolVersion === REMOTE_PROTOCOL_VERSION) return undefined;
  // Servers too old to report a protocol are older still.
  return !(server.protocolVersion > REMOTE_PROTOCOL_VERSION)
    ? `${serverName} runs an older Wisp server (${server.version}) that this app cannot use. Update the server to connect.`
    : `${serverName} runs a newer Wisp server (${server.version}) than this app understands. Update this app to connect.`;
}

function invalid(message: string): BackendResult<never> {
  return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}
