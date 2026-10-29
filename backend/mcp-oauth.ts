import { randomBytes, randomUUID } from "node:crypto";

import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import { WispBackendError } from "./backend-error.js";
import type { McpSecretStore } from "./mcp-secret-store.js";
import { OAuthRedirectReceiver, type OAuthRelay, type SignInBrowser } from "./oauth-redirect.js";

const STATE_BYTES = 16;

/** Where an MCP sign-in's browser runs; see SignInBrowser. */
export type McpSignInBrowser = SignInBrowser;
export type McpOAuthRelay = OAuthRelay;

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
  private readonly redirects: OAuthRedirectReceiver;
  private interactive = false;
  private cancelled = false;
  private stateValue: string | undefined;
  private codeVerifierValue: string | undefined;

  constructor(options: McpOAuthProviderOptions) {
    this.serverId = options.serverId;
    this.secrets = options.secrets;
    this.redirects = new OAuthRedirectReceiver({
      openExternal: options.openExternal,
      ...(options.callbackTimeoutMs ? { timeoutMs: options.callbackTimeoutMs } : {}),
      ...(options.callbackHost ? { host: options.callbackHost } : {}),
    });
  }

  /**
   * Controls whether this provider may start an interactive browser sign-in.
   * The bridge enables it only for explicit sign-in operations.
   */
  setInteractiveSignIn(allowed: boolean): void {
    this.interactive = allowed;
  }

  /**
   * Chooses where the next interactive sign-in's browser runs. Call before
   * ensureCallbackServer: a relay's port becomes the redirect URI. A manual
   * sign-in reports its page through `onManualSignIn` instead of opening it.
   */
  setSignInBrowser(browser: McpSignInBrowser, onManualSignIn?: (authorizationUrl: string) => void): void {
    this.redirects.setBrowser(browser, onManualSignIn);
  }

  /** The page to open by hand while a manual sign-in waits for its result. */
  get manualSignInUrl(): string | undefined {
    return this.redirects.manualSignInUrl;
  }

  get redirectUrl(): string {
    return this.redirects.redirectUrl;
  }

  /** redirect_uris must be known before the SDK reads clientMetadata. */
  ensureCallbackServer(): Promise<string> {
    return this.redirects.ensureListening();
  }

  /**
   * Closes the loopback listener unless a sign-in is waiting on it. The port is
   * remembered, so the redirect URL the SDK reads stays the same. Background
   * connections call this once connected: they can never finish a browser
   * sign-in, so keeping a listener open for them only holds a local port.
   */
  releaseCallbackServer(): void {
    this.redirects.release();
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
    if (this.cancelled) return;
    this.persist(() =>
      this.secrets.setOAuthClientRegistration(this.serverId, {
        clientId: clientInformation.client_id,
        ...(clientInformation.client_secret ? { clientSecret: clientInformation.client_secret } : {}),
      }),
    );
  }

  /**
   * The SDK saves credentials synchronously, so they reach the secret store
   * in the background, one after another in the order they were saved.
   */
  private persist(write: () => Promise<unknown>): void {
    this.writes = this.writes.then(write).catch(() => undefined);
  }

  private writes: Promise<unknown> = Promise.resolve();

  /**
   * Resolves once every credential saved so far is in the secret store, so a
   * view built afterwards sees the sign-in that just completed.
   */
  async writesSettled(): Promise<void> {
    await this.writes;
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
    if (this.cancelled) return;
    this.persist(() =>
      this.secrets.setOAuthTokens(this.serverId, {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(typeof tokens.expires_in === "number" ? { expiresAt: Date.now() + tokens.expires_in * 1_000 } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      }),
    );
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
    if (!this.interactive || this.cancelled) throw new McpSignInRequiredError();
    if (!authorizationUrl.searchParams.has("state") && this.stateValue) {
      authorizationUrl.searchParams.set("state", this.stateValue);
    }
    // The URL comes from server-supplied metadata and is handed to the OS; the
    // receiver holds it to the same HTTPS-only rule as MCP endpoints.
    await this.redirects.open(authorizationUrl);
  }

  /**
   * Completes a waiting sign-in with the address the browser was redirected
   * to, pasted by the user when nothing could listen for it. The state must be
   * this flow's, so an address from another sign-in is refused.
   */
  finishWithRedirect(redirectUrl: string): void {
    this.redirects.finishWithRedirect(redirectUrl);
  }

  /**
   * Resolves with the loopback callback parameters after the user completes
   * browser sign-in. The state parameter is validated against the flow.
   */
  waitForCallback(): Promise<URLSearchParams> {
    return this.redirects.wait();
  }

  /**
   * Cancels this provider's sign-in for good: a pending callback wait rejects
   * now, a redirect that has not happened yet never opens the browser, and
   * tokens or registrations that arrive afterwards are not persisted. The
   * loopback server stays up until dispose; the flow's owner tears that down.
   */
  cancelSignIn(): void {
    this.cancelled = true;
    this.redirects.cancel(new WispBackendError("aborted", "The sign-in was cancelled."));
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") {
      this.tokensSnapshot = undefined;
      this.persist(() => this.secrets.clearOAuthTokens(this.serverId));
    }
    if (scope === "all" || scope === "client") this.clientInformationSnapshot = undefined;
    if (scope === "all" || scope === "verifier") this.codeVerifierValue = undefined;
  }

  /** Stops the loopback server and cancels any pending callback wait. */
  dispose(): void {
    this.redirects.dispose();
    this.stateValue = undefined;
    this.codeVerifierValue = undefined;
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
