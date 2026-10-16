import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const CALLBACK_PATH = "/callback";
/** A listener nobody completes closes on its own, even if the server never says so. */
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_LISTENERS = 4;

export interface OAuthRedirectRelayOptions {
  openExternal: (url: string) => Promise<void>;
  ttlMs?: number;
  host?: string;
}

interface Listener {
  server: Server;
  port: number;
  timer: ReturnType<typeof setTimeout>;
  waiting?: { state: string; resolve: (query: string) => void; reject: (error: Error) => void };
}

/**
 * Receives OAuth redirects on this computer for a Wisp server on another one.
 * The server registers `http://127.0.0.1:<port>/callback` with the port this
 * relay listens on, asks it to open the browser, and gets back only the
 * redirect's query string; the server exchanges the code with a PKCE verifier
 * this app never sees. Listeners accept loopback connections only, check the
 * flow's state, serve one redirect, and close on their own after a while.
 */
export class OAuthRedirectRelay {
  private readonly listeners = new Map<string, Listener>();
  private readonly ttlMs: number;
  private readonly host: string;

  constructor(private readonly options: OAuthRedirectRelayOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.host = options.host ?? "127.0.0.1";
  }

  /** Opens a listener on a free loopback port; resolves with its ID and port. */
  async listen(): Promise<[listenerId: string, port: string]> {
    // A server that keeps asking without finishing cannot hold many ports.
    while (this.listeners.size >= MAX_LISTENERS) this.close(this.listeners.keys().next().value!);
    const listenerId = randomUUID();
    const server = createServer((request, response) => this.handle(listenerId, request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.host, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("The sign-in listener could not start.");
    }
    const timer = setTimeout(() => this.close(listenerId, "The sign-in timed out."), this.ttlMs);
    timer.unref?.();
    this.listeners.set(listenerId, { server, port: address.port, timer });
    return [listenerId, String(address.port)];
  }

  /**
   * Opens the browser at the authorization URL and resolves with the query
   * string of the redirect that carries `state`. The listener closes after it.
   */
  async redirect(listenerId: string, authorizationUrl: string, state: string): Promise<string> {
    const listener = this.listeners.get(listenerId);
    if (!listener) throw new Error("This sign-in is no longer active.");
    if (listener.waiting) throw new Error("This sign-in is already waiting for the browser.");
    let url: URL;
    try {
      url = new URL(authorizationUrl);
    } catch {
      throw new Error("The sign-in address is invalid.");
    }
    // Handed to the OS, so only an HTTPS page without embedded credentials.
    if (url.protocol !== "https:" || url.username || url.password || !state) {
      throw new Error("The sign-in address is not safe to open.");
    }
    const result = new Promise<string>((resolve, reject) => {
      listener.waiting = { state, resolve, reject };
    });
    try {
      await this.options.openExternal(url.toString());
    } catch (error) {
      this.close(listenerId, "The browser could not be opened.");
      throw error;
    }
    return result;
  }

  /** Stops a listener; a pending redirect fails with `reason`. Unknown IDs are ignored. */
  close(listenerId: string, reason = "The sign-in was cancelled."): void {
    const listener = this.listeners.get(listenerId);
    if (!listener) return;
    this.listeners.delete(listenerId);
    clearTimeout(listener.timer);
    listener.server.close();
    listener.server.closeAllConnections?.();
    listener.waiting?.reject(new Error(reason));
  }

  closeAll(): void {
    for (const listenerId of [...this.listeners.keys()]) this.close(listenerId, "Wisp closed the sign-in.");
  }

  private handle(listenerId: string, request: IncomingMessage, response: ServerResponse): void {
    const finish = (status: number, message: string): void => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Wisp Bot</title><p>${message}</p>`);
    };
    const listener = this.listeners.get(listenerId);
    const url = new URL(request.url ?? "/", `http://${this.host}`);
    if (url.pathname !== CALLBACK_PATH) {
      finish(404, "Not found.");
      return;
    }
    const waiting = listener?.waiting;
    if (!waiting) {
      finish(400, "This sign-in window is no longer active. Return to Wisp and try again.");
      return;
    }
    if (url.searchParams.get("state") !== waiting.state) {
      finish(400, "The sign-in response could not be verified. Return to Wisp and try again.");
      return;
    }
    listener!.waiting = undefined;
    waiting.resolve(url.search.slice(1));
    finish(200, "Sign-in complete. You can close this window and return to Wisp.");
    // Close after the page is sent; the server finishes the exchange on its side.
    response.once("finish", () => this.close(listenerId));
  }
}
