import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { WispBackendError } from "./backend-error.js";
import type { McpSecretStore } from "./mcp-secret-store.js";

const CALLBACK_PATH = "/callback";
const STATE_BYTES = 16;

export interface McpOAuthProviderOptions {
  serverId: string;
  secrets: McpSecretStore;
  /** Opens the system browser; injected so tests can capture the URL. */
  openExternal: (url: string) => Promise<void>;
  /** Bounds the wait for the browser callback. */
  callbackTimeoutMs?: number;
  callbackHost?: string;
}

/**
 * Interactive OAuth provider for remote MCP servers. Implements PKCE with a
 * local loopback callback, persists tokens and dynamic client registration in
 * the encrypted MCP secret store, and never embeds a client secret. The
 * loopback server is authentication infrastructure only; it does not add local
 * MCP server support.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly serverId: string;
  private readonly secrets: McpSecretStore;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly callbackTimeoutMs: number;
  private readonly callbackHost: string;
  private interactive = false;
  private server: Server | undefined;
  private port: number | undefined;
  private stateValue: string | undefined;
  private codeVerifierValue: string | undefined;
  private callback:
    | {
        promise: Promise<URLSearchParams>;
        resolve: (value: URLSearchParams) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverId = options.serverId;
    this.secrets = options.secrets;
    this.openExternal = options.openExternal;
    this.callbackTimeoutMs = options.callbackTimeoutMs ?? 300_000;
    this.callbackHost = options.callbackHost ?? "127.0.0.1";
  }

  /**
   * Controls whether this provider may start an interactive browser sign-in.
   * The bridge enables it only for explicit sign-in operations.
   */
  setInteractiveSignIn(allowed: boolean): void {
    this.interactive = allowed;
  }

  get redirectUrl(): string {
    if (!this.port) throw new WispBackendError("internal_error", "The sign-in callback server is not running.");
    return `http://${this.callbackHost}:${this.port}${CALLBACK_PATH}`;
  }

  /** redirect_uris must be known before the SDK reads clientMetadata. */
  async ensureCallbackServer(): Promise<string> {
    if (!this.server) {
      this.server = createServer((request, response) => this.handleCallback(request, response));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, this.callbackHost, () => resolve());
      });
      const address = this.server.address();
      if (!address || typeof address === "string")
        throw new WispBackendError("internal_error", "The sign-in callback server could not start.");
      this.port = address.port;
    }
    return this.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    // token_endpoint_auth_method "none": a public client; no secret is embedded.
    return {
      client_name: "Wisp Bot",
      client_uri: "https://github.com/gustmrg/wisp-bot",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    // Registration is persisted synchronously by saveClientInformation; reads
    // during an active flow use the synchronous snapshot written above.
    return this.clientInformationSnapshot;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this.clientInformationSnapshot = clientInformation;
    void this.secrets
      .setOAuthClientRegistration(this.serverId, {
        clientId: clientInformation.client_id,
        ...(clientInformation.client_secret ? { clientSecret: clientInformation.client_secret } : {}),
      })
      .catch(() => undefined);
  }

  private clientInformationSnapshot: StoredOAuthClientInformation | undefined;

  /** Loads persisted registration before a flow starts. */
  async loadPersistedClientInformation(): Promise<void> {
    const registration = await this.secrets.oauthClientRegistration(this.serverId);
    if (registration) {
      this.clientInformationSnapshot = {
        client_id: registration.clientId,
        ...(registration.clientSecret ? { client_secret: registration.clientSecret } : {}),
      };
    }
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.tokensSnapshot;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.tokensSnapshot = tokens;
    void this.secrets
      .setOAuthTokens(this.serverId, {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(typeof tokens.expires_in === "number" ? { expiresAt: Date.now() + tokens.expires_in * 1_000 } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      })
      .catch(() => undefined);
  }

  private tokensSnapshot: StoredOAuthTokens | undefined;

  /** Loads persisted tokens before a flow starts. */
  async loadPersistedTokens(): Promise<void> {
    const tokens = await this.secrets.oauthTokens(this.serverId);
    if (tokens) {
      this.tokensSnapshot = {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expires_in: Math.max(0, Math.round((tokens.expiresAt - Date.now()) / 1_000)) } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      };
    }
  }

  state(): string {
    this.stateValue = randomBytes(STATE_BYTES).toString("base64url");
    return this.stateValue;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue)
      throw new WispBackendError("internal_error", "The sign-in flow has no pending code verifier.");
    return this.codeVerifierValue;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Background flows (token refresh attempts, discovery, tool dispatch) must
    // never open a browser. The SDK invokes this before reporting that a
    // redirect is needed, so the gate has to live here.
    if (!this.interactive) throw new McpSignInRequiredError();
    if (!this.server) await this.ensureCallbackServer();
    this.beginWaitingForCallback();
    await this.openExternal(authorizationUrl.toString());
  }

  /**
   * Resolves with the loopback callback parameters after the user completes
   * browser sign-in. The state parameter is validated against the flow.
   */
  waitForCallback(): Promise<URLSearchParams> {
    if (!this.callback) throw new WispBackendError("invalid_request", "No sign-in flow is in progress.");
    return this.callback.promise;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") {
      this.tokensSnapshot = undefined;
      void this.secrets.clearOAuthTokens(this.serverId).catch(() => undefined);
    }
    if (scope === "all" || scope === "client") this.clientInformationSnapshot = undefined;
    if (scope === "all" || scope === "verifier") this.codeVerifierValue = undefined;
  }

  /** Stops the loopback server and cancels any pending callback wait. */
  dispose(): void {
    this.cancelCallback(new WispBackendError("aborted", "The sign-in flow was cancelled."));
    this.server?.close();
    this.server = undefined;
    this.port = undefined;
    this.stateValue = undefined;
    this.codeVerifierValue = undefined;
  }

  private beginWaitingForCallback(): void {
    this.cancelCallback(new WispBackendError("aborted", "A newer sign-in flow replaced this one."));
    let resolve!: (value: URLSearchParams) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<URLSearchParams>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(
      () => this.cancelCallback(new WispBackendError("aborted", "The sign-in request timed out.")),
      this.callbackTimeoutMs,
    );
    this.callback = { promise, resolve, reject, timer };
  }

  private cancelCallback(error: unknown): void {
    const pending = this.callback;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.callback = undefined;
    pending.reject(error);
  }

  private handleCallback(request: IncomingMessage, response: ServerResponse): void {
    const pending = this.callback;
    const url = new URL(request.url ?? "/", `http://${this.callbackHost}${this.port ? `:${this.port}` : ""}`);
    const finish = (status: number, message: string): void => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Wisp Bot</title><p>${message}</p>`);
    };
    if (url.pathname !== CALLBACK_PATH) {
      finish(404, "Not found.");
      return;
    }
    if (!pending) {
      finish(400, "This sign-in window is no longer active. Return to Wisp and try again.");
      return;
    }
    if (this.stateValue && url.searchParams.get("state") !== this.stateValue) {
      finish(400, "The sign-in response could not be verified. Return to Wisp and try again.");
      return;
    }
    clearTimeout(pending.timer);
    this.callback = undefined;
    pending.resolve(url.searchParams);
    finish(200, "Sign-in complete. You can close this window and return to Wisp.");
  }
}

export function newOAuthState(): string {
  return randomUUID();
}

/**
 * Thrown instead of opening a browser when a background flow needs interactive
 * sign-in. Bridges translate it into a "needs sign-in" connection state.
 */
export class McpSignInRequiredError extends Error {
  constructor() {
    super("MCP sign-in is required.");
    this.name = "McpSignInRequiredError";
  }
}
