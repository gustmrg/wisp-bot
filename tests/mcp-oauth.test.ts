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

describe("McpOAuthProvider sign-in on another computer", () => {
  const providers: McpOAuthProvider[] = [];

  afterEach(() => {
    for (const provider of providers.splice(0)) provider.dispose();
  });

  function createProvider() {
    const openExternal = vi.fn(async () => undefined);
    const provider = new McpOAuthProvider({ serverId: "server-1", secrets: {} as McpSecretStore, openExternal });
    provider.setInteractiveSignIn(true);
    providers.push(provider);
    return { provider, openExternal };
  }

  it("registers the relay's port and takes the redirect from it without listening here", async () => {
    const { provider, openExternal } = createProvider();
    let answer!: (query: string) => void;
    const relay = {
      port: 43_210,
      waitForRedirect: vi.fn(
        (_url: string, _state: string) =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
      ),
      close: vi.fn(),
    };
    provider.setSignInBrowser({ kind: "relay", relay });

    expect(await provider.ensureCallbackServer()).toBe("http://127.0.0.1:43210/callback");
    expect(await isListening(provider.redirectUrl)).toBe(false);
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=abc"));
    expect(openExternal).not.toHaveBeenCalled();
    expect(relay.waitForRedirect).toHaveBeenCalledWith("https://auth.example.com/authorize?state=abc", "abc");

    const callback = provider.waitForCallback();
    answer("code=xyz&state=abc");
    expect((await callback).get("code")).toBe("xyz");
    provider.dispose();
    expect(relay.close).toHaveBeenCalled();
  });

  it("refuses a relayed redirect from another flow and stops the relay on cancel", async () => {
    const { provider } = createProvider();
    const relay = { port: 43_211, waitForRedirect: vi.fn(async () => "code=xyz&state=other"), close: vi.fn() };
    provider.setSignInBrowser({ kind: "relay", relay });
    await provider.ensureCallbackServer();
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=abc"));
    await expect(provider.waitForCallback()).rejects.toMatchObject({ code: "invalid_request" });

    provider.cancelSignIn();
    expect(relay.close).toHaveBeenCalled();
  });

  it("reports the page of a manual sign-in and finishes it with the pasted address", async () => {
    const { provider, openExternal } = createProvider();
    const onManual = vi.fn();
    provider.setSignInBrowser({ kind: "manual" }, onManual);
    const redirect = await provider.ensureCallbackServer();
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=abc"));

    expect(openExternal).not.toHaveBeenCalled();
    expect(onManual).toHaveBeenCalledWith("https://auth.example.com/authorize?state=abc");
    expect(provider.manualSignInUrl).toBe("https://auth.example.com/authorize?state=abc");
    expect(() => provider.finishWithRedirect("not an address")).toThrow(/not the address/);
    expect(() => provider.finishWithRedirect(`${redirect}?code=xyz&state=other`)).toThrow(/could not be verified/);
    expect(() => provider.finishWithRedirect("http://127.0.0.1:1/elsewhere?state=abc")).toThrow(/not the address/);

    const callback = provider.waitForCallback();
    provider.finishWithRedirect(`${redirect}?code=xyz&state=abc`);
    expect((await callback).get("code")).toBe("xyz");
    expect(provider.manualSignInUrl).toBeUndefined();
    expect(() => provider.finishWithRedirect(`${redirect}?code=xyz&state=abc`)).toThrow(/No sign-in is waiting/);
  });

  it("still accepts the redirect on this computer during a manual sign-in", async () => {
    const { provider } = createProvider();
    provider.setSignInBrowser({ kind: "manual" });
    const redirect = await provider.ensureCallbackServer();
    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=abc"));
    const callback = provider.waitForCallback();

    expect((await fetch(`${redirect}?code=xyz&state=abc`)).status).toBe(200);
    expect((await callback).get("code")).toBe("xyz");
  });
});
