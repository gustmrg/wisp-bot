import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { McpOAuthProvider } from "../backend/mcp-oauth.js";
import type { McpSecretStore } from "../backend/mcp-secret-store.js";

describe("McpOAuthProvider authorization redirect", () => {
  const providers: McpOAuthProvider[] = [];

  afterEach(() => {
    for (const provider of providers.splice(0)) provider.dispose();
  });

  function createProvider() {
    const openExternal = vi.fn(async () => undefined);
    const provider = new McpOAuthProvider({
      serverId: "server-1",
      secrets: {} as McpSecretStore,
      openExternal,
    });
    provider.setInteractiveSignIn(true);
    providers.push(provider);
    return { provider, openExternal };
  }

  it.each([
    "http://auth.example.com/authorize",
    "file:///etc/passwd",
    "smb://attacker.example/share",
    "vscode://extension/install",
    "https://user:pass@auth.example.com/authorize",
  ])("refuses to open an unsafe server-supplied authorization URL: %s", async (url) => {
    const { provider, openExternal } = createProvider();

    await expect(provider.redirectToAuthorization(new URL(url))).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens an HTTPS authorization URL in the system browser", async () => {
    const { provider, openExternal } = createProvider();

    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=abc"));

    expect(openExternal).toHaveBeenCalledWith("https://auth.example.com/authorize?state=abc");
    const pending = provider.waitForCallback();
    provider.dispose();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

function isListening(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("McpOAuthProvider callback listener", () => {
  it("closes an idle listener but keeps the redirect URL the SDK already read", async () => {
    const provider = new McpOAuthProvider({
      serverId: "server-1",
      secrets: {} as McpSecretStore,
      openExternal: vi.fn(),
    });
    const redirectUrl = await provider.ensureCallbackServer();
    expect(await isListening(redirectUrl)).toBe(true);

    provider.releaseCallbackServer();

    expect(provider.redirectUrl).toBe(redirectUrl);
    expect(provider.clientMetadata.redirect_uris).toEqual([redirectUrl]);
    expect(await isListening(redirectUrl)).toBe(false);
    provider.dispose();
  });

  it("keeps the listener while a browser sign-in is waiting on it", async () => {
    const provider = new McpOAuthProvider({
      serverId: "server-1",
      secrets: {} as McpSecretStore,
      openExternal: vi.fn(async () => undefined),
    });
    provider.setInteractiveSignIn(true);
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
    const pending = provider.waitForCallback();

    provider.releaseCallbackServer();

    expect(await isListening(provider.redirectUrl)).toBe(true);
    provider.dispose();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});
