import type { PluginOAuthConfig } from "../plugin-oauth.js";
import { type Fields, requestJson } from "./shared.js";

/**
 * Google's OAuth endpoints for the plugins that sign in with the user's own
 * Google Cloud client. `access_type=offline` and `prompt=consent` make Google
 * return a refresh token on every sign-in, including a repeated one.
 */
export function googleOAuth(scopes: ReadonlyArray<string>, account: PluginOAuthConfig["account"]): PluginOAuthConfig {
  return {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    scopes,
    authorizationParams: { access_type: "offline", prompt: "consent" },
    account,
  };
}

/** What to check when Google refuses a plugin's request (HTTP 401 or 403). */
export function googleAuthHint(api: string): string {
  return `Check that the ${api} is enabled in your Google Cloud project and that access was allowed; sign in again if it was revoked.`;
}

/** A Google API request with the plugin's access token. */
export function googleRequest(
  provider: string,
  api: string,
  accessToken: string,
  url: string,
  init: { method?: string; body?: unknown; authHint?: string } = {},
  signal?: AbortSignal,
): Promise<Fields> {
  return requestJson(
    provider,
    url,
    {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    signal,
    init.authHint ?? googleAuthHint(api),
  );
}
