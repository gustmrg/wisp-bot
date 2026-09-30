import { afterEach, describe, expect, it, vi } from "vitest";

import { McpOAuthProvider } from "../electron/backend/mcp-oauth.js";
import type { McpSecretStore } from "../electron/backend/mcp-secret-store.js";

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
