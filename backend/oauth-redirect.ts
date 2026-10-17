import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { WispBackendError } from "./backend-error.js";

const CALLBACK_PATH = "/callback";

/**
 * Where an interactive sign-in's browser runs, and how the browser's redirect
 * to `http://127.0.0.1:<port>/callback` gets back to this computer:
 *
 * - `local`: on this computer; a loopback listener here receives it.
 * - `relay`: on the computer of the app that asked; that app listens on its own
 *   loopback and hands the redirect back. Tokens are still exchanged here.
 * - `manual`: nothing listens where the browser is (the browser app, a phone);
 *   the user opens the page and pastes the address the browser was sent to.
 */
export type SignInBrowser = { kind: "local" } | { kind: "relay"; relay: OAuthRelay } | { kind: "manual" };

/** A loopback listener on another computer, opened for one sign-in. */
export interface OAuthRelay {
  /** The port the other computer listens on; it becomes the redirect URI's port. */
  readonly port: number;
  /** Opens the browser there and resolves with the redirect's query string. */
  waitForRedirect(authorizationUrl: string, state: string): Promise<string>;
  /** Stops listening there; a pending wait rejects. Safe to call more than once. */
  close(): void;
}

export interface OAuthRedirectReceiverOptions {
  /** Opens the system browser; injected so tests can capture the URL. */
  openExternal: (url: string) => Promise<void>;
  /** Bounds the wait for the browser's redirect. */
  timeoutMs?: number;
  host?: string;
}

interface PendingRedirect {
  promise: Promise<URLSearchParams>;
  resolve: (value: URLSearchParams) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Receives the redirect of one interactive OAuth sign-in at a loopback
 * callback, wherever the browser runs (see SignInBrowser). It checks the
 * flow's state on every path; exchanging the code is up to its owner.
 */
export class OAuthRedirectReceiver {
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly host: string;
  private browser: SignInBrowser = { kind: "local" };
  private onManualSignIn: ((authorizationUrl: string) => void) | undefined;
  private manualUrl: string | undefined;
  private server: Server | undefined;
  private port: number | undefined;
  private state: string | undefined;
  private pending: PendingRedirect | undefined;
  /** The latest flow's outcome once it settled, for a wait that starts after it. */
  private settled: Promise<URLSearchParams> | undefined;

  constructor(options: OAuthRedirectReceiverOptions) {
    this.openExternal = options.openExternal;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.host = options.host ?? "127.0.0.1";
  }

  /**
   * Chooses where the next sign-in's browser runs. Call before ensureListening:
   * a relay's port becomes the redirect URI. A manual sign-in reports its page
   * through `onManualSignIn` instead of opening it.
   */
  setBrowser(browser: SignInBrowser, onManualSignIn?: (authorizationUrl: string) => void): void {
    this.browser = browser;
    this.onManualSignIn = onManualSignIn;
  }

  /** Whether a sign-in waits for its redirect. */
  get waiting(): boolean {
    return this.pending !== undefined;
  }

  /** The page to open by hand while a manual sign-in waits for its result. */
  get manualSignInUrl(): string | undefined {
    return this.pending ? this.manualUrl : undefined;
  }

  get redirectUrl(): string {
    if (!this.port) throw new WispBackendError("internal_error", "The sign-in callback server is not running.");
    return `http://${this.host}:${this.port}${CALLBACK_PATH}`;
  }

  /** Starts listening, or takes the relay's port, so the redirect URI exists before a client is registered. */
  async ensureListening(): Promise<string> {
    // The other computer already listens; nothing here needs a port.
    if (this.browser.kind === "relay") {
      this.port = this.browser.relay.port;
      return this.redirectUrl;
    }
    if (!this.server) {
      this.server = createServer((request, response) => this.handle(request, response));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, this.host, () => resolve());
      });
      const address = this.server.address();
      if (!address || typeof address === "string")
        throw new WispBackendError("internal_error", "The sign-in callback server could not start.");
      this.port = address.port;
    }
    return this.redirectUrl;
  }

  /**
   * Closes the loopback listener unless a sign-in is waiting on it. The port is
   * remembered, so the redirect URL stays the same.
   */
  release(): void {
    if (this.pending) return;
    this.server?.close();
    this.server = undefined;
  }

  /**
   * Starts waiting for the redirect, then sends the browser to the
   * authorization page: here, through the relay, or by showing it to the user.
   * The URL is handed to an operating system, so it must be HTTPS.
   */
  async open(authorizationUrl: URL): Promise<void> {
    if (authorizationUrl.protocol !== "https:" || authorizationUrl.username || authorizationUrl.password) {
      throw new WispBackendError("invalid_configuration", "The sign-in server returned an unsafe authorization URL.");
    }
    const url = authorizationUrl.toString();
    const state = authorizationUrl.searchParams.get("state") ?? "";
    this.state = state;
    const browser = this.browser;
    if (browser.kind === "relay") {
      this.beginWaiting();
      browser.relay.waitForRedirect(url, state).then(
        (query) => {
          const failure = this.resolve(new URLSearchParams(query));
          if (failure) this.cancel(new WispBackendError("invalid_request", failure));
        },
        (error: unknown) =>
          this.cancel(
            error instanceof WispBackendError
              ? error
              : new WispBackendError("aborted", "The sign-in did not complete."),
          ),
      );
      return;
    }
    if (!this.server) await this.ensureListening();
    this.beginWaiting();
    if (browser.kind === "manual") {
      this.manualUrl = url;
      this.onManualSignIn?.(url);
      return;
    }
    await this.openExternal(url);
  }

  /** Resolves with the redirect's parameters once the state matched. */
  wait(): Promise<URLSearchParams> {
    // A relayed or pasted redirect can settle the flow before anyone waits on it.
    const flow = this.pending?.promise ?? this.settled;
    if (!flow) throw new WispBackendError("invalid_request", "No sign-in flow is in progress.");
    return flow;
  }

  /**
   * Completes a waiting sign-in with the address the browser was redirected
   * to, pasted by the user when nothing could listen for it. The state must be
   * this flow's, so an address from another sign-in is refused.
   */
  finishWithRedirect(redirectUrl: string): void {
    if (!this.pending) throw new WispBackendError("invalid_request", "No sign-in is waiting for this connection.");
    let url: URL;
    try {
      url = new URL(redirectUrl);
    } catch {
      throw new WispBackendError("invalid_request", "That is not the address the sign-in sent you to.");
    }
    if (url.pathname !== CALLBACK_PATH || !url.searchParams.has("state")) {
      throw new WispBackendError("invalid_request", "That is not the address the sign-in sent you to.");
    }
    const failure = this.resolve(url.searchParams);
    if (failure) throw new WispBackendError("invalid_request", failure);
  }

  /** Ends a waiting sign-in with `error` and stops a relay. */
  cancel(error: unknown = new WispBackendError("aborted", "The sign-in was cancelled.")): void {
    const pending = this.pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending = undefined;
      this.manualUrl = undefined;
      pending.reject(error);
    }
    if (this.browser.kind === "relay") this.browser.relay.close();
  }

  /** Stops listening and ends any waiting sign-in. */
  dispose(): void {
    this.cancel(new WispBackendError("aborted", "The sign-in flow was cancelled."));
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.state = undefined;
    this.manualUrl = undefined;
    this.settled = undefined;
  }

  private beginWaiting(): void {
    const previous = this.pending;
    if (previous) {
      clearTimeout(previous.timer);
      this.pending = undefined;
      previous.reject(new WispBackendError("aborted", "A newer sign-in flow replaced this one."));
    }
    let resolve!: (value: URLSearchParams) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<URLSearchParams>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Nobody may be waiting yet when a flow is cancelled; that is not an unhandled failure.
    promise.catch(() => undefined);
    this.settled = promise;
    const timer = setTimeout(
      () => this.cancel(new WispBackendError("aborted", "The sign-in request timed out.")),
      this.timeoutMs,
    );
    this.pending = { promise, resolve, reject, timer };
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", `http://${this.host}${this.port ? `:${this.port}` : ""}`);
    const finish = (status: number, message: string): void => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Wisp Bot</title><p>${message}</p>`);
    };
    if (url.pathname !== CALLBACK_PATH) {
      finish(404, "Not found.");
      return;
    }
    if (!this.pending) {
      finish(400, "This sign-in window is no longer active. Return to Wisp and try again.");
      return;
    }
    const failure = this.resolve(url.searchParams);
    if (failure) finish(400, `${failure} Return to Wisp and try again.`);
    else finish(200, "Sign-in complete. You can close this window and return to Wisp.");
  }

  /** Hands the redirect to the waiting flow when its state matches; returns why not otherwise. */
  private resolve(params: URLSearchParams): string | undefined {
    const pending = this.pending;
    if (!pending) return "This sign-in is no longer active.";
    if (this.state && params.get("state") !== this.state) return "The sign-in response could not be verified.";
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.manualUrl = undefined;
    pending.resolve(params);
    return undefined;
  }
}
