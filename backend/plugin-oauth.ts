import { createHash, randomBytes } from "node:crypto";

import { WispBackendError } from "./backend-error.js";

/** How a plugin's provider signs in: OAuth 2.0 with PKCE and the user's own client. */
export interface PluginOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Best-effort revocation when the connection is removed. */
  revocationEndpoint?: string;
  scopes: ReadonlyArray<string>;
  /** Extra authorization parameters, such as Google's `access_type=offline`. */
  authorizationParams?: Readonly<Record<string, string>>;
  /** The signed-in account to show, such as an email address. */
  account?: (accessToken: string, fetchFn: typeof fetch, signal: AbortSignal) => Promise<string | undefined>;
}

export interface PluginOAuthClient {
  clientId: string;
  /** Desktop clients have a secret that is not confidential; it still stays on the server. */
  clientSecret?: string;
}

export interface PluginOAuthTokens {
  access: string;
  refresh: string;
  /** Milliseconds since the epoch. */
  expires: number;
  scope?: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 65_536;

/** Thrown when the refresh token no longer works: the user must sign in again. */
export class PluginSignInRequiredError extends WispBackendError {
  constructor(name: string) {
    super("configuration_required", `Sign in to ${name} again: its access expired or was revoked.`);
  }
}

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(16).toString("base64url"),
  };
}

export function authorizationUrl(
  config: PluginOAuthConfig,
  client: PluginOAuthClient,
  redirectUri: string,
  pkce: { challenge: string; state: string },
): URL {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(config.authorizationParams ?? {})) url.searchParams.set(key, value);
  return url;
}

/** Exchanges the authorization code; every requested scope must have been granted. */
export async function exchangeCode(
  fetchFn: typeof fetch,
  config: PluginOAuthConfig,
  client: PluginOAuthClient,
  request: { code: string; redirectUri: string; verifier: string },
  signal: AbortSignal,
): Promise<PluginOAuthTokens> {
  const body = await tokenRequest(
    fetchFn,
    config,
    client,
    {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.verifier,
    },
    signal,
  );
  if (body.error) {
    throw new WispBackendError(
      "configuration_required",
      body.error === "invalid_client" || body.error === "unauthorized_client"
        ? "The OAuth client was refused. Check its client ID and secret."
        : "The sign-in could not be completed. Try again.",
    );
  }
  const tokens = parseTokens(body, undefined);
  if (!tokens.refresh) {
    throw new WispBackendError(
      "configuration_required",
      "The provider did not allow offline access. Remove Wisp's access in your account settings, then connect again.",
    );
  }
  const granted = new Set((tokens.scope ?? config.scopes.join(" ")).split(/\s+/));
  if (config.scopes.some((scope) => !granted.has(scope))) {
    throw new WispBackendError(
      "configuration_required",
      "Not every permission was allowed. Connect again and allow all of them.",
    );
  }
  return tokens;
}

/** Gets a new access token; a refused refresh token means the user must sign in again. */
export async function refreshTokens(
  fetchFn: typeof fetch,
  config: PluginOAuthConfig,
  client: PluginOAuthClient,
  refresh: string,
  name: string,
  signal: AbortSignal,
): Promise<PluginOAuthTokens> {
  const body = await tokenRequest(
    fetchFn,
    config,
    client,
    { grant_type: "refresh_token", refresh_token: refresh },
    signal,
  );
  if (body.error === "invalid_grant" || body.error === "invalid_client" || body.error === "unauthorized_client") {
    throw new PluginSignInRequiredError(name);
  }
  if (body.error) throw new WispBackendError("internal_error", `${name} could not renew its access.`, true);
  // Providers may keep the refresh token and omit it from the response.
  return parseTokens(body, refresh);
}

/** Best effort: removing the connection should also end the provider's grant. */
export async function revokeToken(fetchFn: typeof fetch, config: PluginOAuthConfig, token: string): Promise<void> {
  if (!config.revocationEndpoint) return;
  await fetchFn(config.revocationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: string;
}

async function tokenRequest(
  fetchFn: typeof fetch,
  config: PluginOAuthConfig,
  client: PluginOAuthClient,
  fields: Record<string, string>,
  signal: AbortSignal,
): Promise<TokenResponse> {
  const response = await fetchFn(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      ...fields,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }).toString(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new WispBackendError("internal_error", "The sign-in server sent an unexpected response.");
  }
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new WispBackendError("internal_error", "The sign-in server sent an unexpected response.", true);
  }
  if (!response.ok && !body.error) {
    throw new WispBackendError("internal_error", "The sign-in server could not be reached.", true);
  }
  return { ...body, ...(typeof body.error === "string" ? { error: body.error } : {}) };
}

function parseTokens(body: TokenResponse, previousRefresh: string | undefined): PluginOAuthTokens {
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new WispBackendError("internal_error", "The sign-in server sent no access token.");
  }
  const refresh = typeof body.refresh_token === "string" ? body.refresh_token : (previousRefresh ?? "");
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3_600;
  return {
    access: body.access_token,
    refresh,
    expires: Date.now() + expiresIn * 1_000,
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}
