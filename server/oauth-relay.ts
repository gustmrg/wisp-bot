import type { McpOAuthRelay } from "../backend/mcp-oauth.js";
import type { HostRequest } from "../shared/remote-protocol.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Asks the desktop app that started a sign-in; resolves with the answer's values. */
export type AskSignInDevice = (
  request: DistributiveOmit<HostRequest, "id">,
  timeoutMs: number,
) => Promise<ReadonlyArray<string>>;

const LISTEN_TIMEOUT_MS = 15_000;
/** Longer than the provider's own wait, which cancels the relay first. */
const REDIRECT_TIMEOUT_MS = 310_000;
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Opens a loopback listener in the desktop app on the user's computer, so the
 * browser there can complete an OAuth sign-in for this server. Only the
 * redirect's query string comes back; the code is exchanged here with the
 * PKCE verifier that never leaves the server. Rejects when the app cannot
 * listen (the browser app), so the caller can fall back.
 */
export async function openOAuthRelay(ask: AskSignInDevice): Promise<McpOAuthRelay> {
  const [listenerId, portText] = await ask({ kind: "oauthListen" }, LISTEN_TIMEOUT_MS);
  const port = Number(portText);
  if (!listenerId || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The app answered the sign-in listener request without a port.");
  }
  let closed = false;
  return {
    port,
    async waitForRedirect(authorizationUrl, state) {
      const [query] = await ask(
        { kind: "oauthRedirect", listenerId, url: authorizationUrl, state },
        REDIRECT_TIMEOUT_MS,
      );
      if (query === undefined) throw new Error("The app answered without the sign-in result.");
      return query;
    },
    close() {
      if (closed) return;
      closed = true;
      // The app also closes listeners on its own after a while; a lost close only delays that.
      void ask({ kind: "oauthClose", listenerId }, CLOSE_TIMEOUT_MS).catch(() => undefined);
    },
  };
}
