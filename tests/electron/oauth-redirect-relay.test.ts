import { afterEach, describe, expect, it, vi } from "vitest";

import { OAuthRedirectRelay } from "../../electron/oauth-redirect-relay.js";

// Listeners bind 127.0.0.1 only; nothing here leaves this computer.
describe("OAuthRedirectRelay", () => {
  const relays: OAuthRedirectRelay[] = [];

  afterEach(() => {
    for (const relay of relays.splice(0)) relay.closeAll();
  });

  function createRelay(ttlMs?: number) {
    const openExternal = vi.fn(async (_url: string) => undefined);
    const relay = new OAuthRedirectRelay({ openExternal, ...(ttlMs ? { ttlMs } : {}) });
    relays.push(relay);
    return { relay, openExternal };
  }

  it("opens the browser and hands back the redirect that carries the flow's state", async () => {
    const { relay, openExternal } = createRelay();
    const [listenerId, port] = await relay.listen();
    const result = relay.redirect(listenerId, "https://auth.example.com/authorize?state=abc", "abc");
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://auth.example.com/authorize?state=abc"));
    const callback = `http://127.0.0.1:${port}/callback`;

    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    expect((await fetch(`${callback}?code=xyz&state=forged`)).status).toBe(400);
    const page = await fetch(`${callback}?code=xyz&state=abc&iss=https%3A%2F%2Fauth.example.com`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign-in complete");
    expect(await result).toBe("code=xyz&state=abc&iss=https%3A%2F%2Fauth.example.com");
    // One redirect per listener: it closes afterwards.
    await vi.waitFor(() => expect(fetch(`${callback}?code=xyz&state=abc`)).rejects.toThrow());
  });

  it.each(["http://auth.example.com/authorize", "file:///etc/passwd", "https://user:pass@auth.example.com/"])(
    "refuses to open an unsafe address: %s",
    async (url) => {
      const { relay, openExternal } = createRelay();
      const [listenerId] = await relay.listen();
      await expect(relay.redirect(listenerId, url, "abc")).rejects.toThrow(/not safe|invalid/);
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it("fails a waiting redirect when the server closes the listener", async () => {
    const { relay } = createRelay();
    const [listenerId, port] = await relay.listen();
    const result = relay.redirect(listenerId, "https://auth.example.com/authorize", "abc");
    relay.close(listenerId);
    await expect(result).rejects.toThrow("The sign-in was cancelled.");
    await expect(fetch(`http://127.0.0.1:${port}/callback?state=abc`)).rejects.toThrow();
    await expect(relay.redirect(listenerId, "https://auth.example.com/authorize", "abc")).rejects.toThrow(
      /no longer active/,
    );
  });

  it("closes a listener nobody completes on its own", async () => {
    const { relay } = createRelay(50);
    const [listenerId] = await relay.listen();
    const result = relay.redirect(listenerId, "https://auth.example.com/authorize", "abc");
    await expect(result).rejects.toThrow("The sign-in timed out.");
  });

  it("keeps only a few listeners open at once", async () => {
    const { relay } = createRelay();
    const [first] = await relay.listen();
    for (let index = 0; index < 4; index += 1) await relay.listen();
    await expect(relay.redirect(first, "https://auth.example.com/authorize", "abc")).rejects.toThrow(
      /no longer active/,
    );
  });
});
