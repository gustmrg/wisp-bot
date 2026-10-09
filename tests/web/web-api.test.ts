import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { adminRequest } from "../../server/admin.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer } from "../../server/wisp-server.js";
import type { ConnectionsView } from "../../shared/connections.js";
import type { Wisp } from "../../shared/conversations.js";
import { isWispBridgeAvailable } from "../../src/lib/wisp-bridge.js";
import { browserDeviceName, createWebWispApi, takePairingCode } from "../../src/web/web-api.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Behaves like a browser on the page's origin: keeps cookies and sends Origin on changes. */
function browserFetch(origin: string): { fetch: typeof fetch; cookies: () => string } {
  const jar = new Map<string, string>();
  const browser: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    if (init.method && init.method !== "GET") headers.set("Origin", origin);
    const response = await fetch(input, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, value] = pair!.split("=");
      if (value) jar.set(name!, value);
      else jar.delete(name!);
    }
    return response;
  };
  return { fetch: browser, cookies: () => [...jar.keys()].join(",") };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

async function until(probe: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const atlas: Wisp = { id: "atlas", name: "Atlas", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE };

describe("browser WispApi", () => {
  it("pairs with a code, runs Wisps on the server, streams events, and signs out", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-web-api-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const server = await createWispServer({
      dataDirectory: directory,
      host: "127.0.0.1",
      port: 0,
      encryption: new MasterKeyEncryption(randomBytes(32)),
      logger: silent,
      agentMode: "fake",
      appVersion: "1.0.0",
      allowModelNetwork: false,
    });
    cleanups.push(() => server.close());
    const browser = browserFetch(server.url);
    const storage = memoryStorage();
    const picks: File[] = [];
    const api = createWebWispApi({
      origin: server.url,
      storage,
      deviceName: browserDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1"),
      appVersion: "1.0.0",
      fetch: browser.fetch,
      pickFiles: async () => picks.splice(0),
    });
    expect(isWispBridgeAvailable(api)).toBe(true);
    const views: ConnectionsView[] = [];
    api.subscribeToConnections((view) => views.push(view));
    const phase = async () => ((await api.getConnections()) as { ok: true; value: ConnectionsView }).value.status.phase;

    await until(async () => (await phase()) === "pairing_required", "pairing to be required");
    expect((await api.getConnections()).ok && views.at(-1)?.canManage).toBe(false);
    const { code } = (await adminRequest(directory, { command: "pair" })) as { code: string };
    await api.activateConnection({ id: "server", pairingCode: code });
    await until(async () => (await phase()) === "connected", "the connection");
    expect(server.auth.devices()).toEqual([expect.objectContaining({ name: "Safari on iPhone", local: false })]);
    // Only the session's identity is stored in the page; the tokens are HttpOnly cookies.
    expect([...storage.values.values()].join()).not.toMatch(/accessToken|refreshToken/);
    expect(browser.cookies()).toBe("wisp_access,wisp_refresh");

    const events: string[] = [];
    api.subscribeToAgentEvents((event) => events.push(event.type));
    await api.saveAiSettings({ selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" }, apiKey: "sk" });
    expect(await api.createWisp({ wisp: atlas, notifyOnUpdatesEnabled: true })).toMatchObject({ ok: true });
    await api.sendMessage({ conversationId: "atlas", requestId: "r1", text: "Hi" });
    await until(() => events.includes("assistant_message_completed"), "the reply");

    // Desktop-only actions explain themselves instead of failing silently.
    expect(await api.checkForUpdates()).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await api.saveConnection({ kind: "url", name: "x", url: "https://x" })).toMatchObject({ ok: false });
    expect(await api.openWorkspaceFolder({ conversationId: "atlas" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });

    // Attached files travel from the browser to the Wisp's workspace on the server.
    expect(await api.attachWorkspaceFiles({ conversationId: "atlas" })).toMatchObject({
      ok: true,
      value: { files: [], workspace: { usedBytes: 0 } },
    });
    picks.push(new File(["hello"], "notes.txt"), new File(["a,b"], "notes.txt"));
    expect(await api.attachWorkspaceFiles({ conversationId: "atlas" })).toEqual({
      ok: true,
      value: {
        files: [
          { name: "notes.txt", path: "inbox/notes.txt", size: 5 },
          { name: "notes (2).txt", path: "inbox/notes (2).txt", size: 3 },
        ],
        workspace: expect.objectContaining({ usedBytes: 8 }),
      },
    });
    // A cookie alone cannot send files: a cross-site form could.
    const forged = await browser.fetch(`${server.url}/api/v1/workspace-files?conversationId=atlas&name=x.txt`, {
      method: "POST",
      body: "x",
    });
    expect(forged.status).toBe(403);

    await api.removeConnection({ id: "server" });
    await until(async () => (await phase()) === "pairing_required", "signing out");
    expect(server.auth.devices()).toEqual([]);
    expect(storage.values.size).toBe(0);
  });

  it("pairs from a scanned link under the name the person gives, and falls back to a code", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-web-api-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const server = await createWispServer({
      dataDirectory: directory,
      host: "127.0.0.1",
      port: 0,
      encryption: new MasterKeyEncryption(randomBytes(32)),
      logger: silent,
      agentMode: "fake",
      appVersion: "1.0.0",
      allowModelNetwork: false,
    });
    cleanups.push(() => server.close());
    const requested: string[] = [];
    const open = (pairingCode: string) => {
      const browser = browserFetch(server.url);
      const api = createWebWispApi({
        origin: server.url,
        storage: memoryStorage(),
        deviceName: "Safari on iPhone",
        appVersion: "1.0.0",
        pairingCode,
        fetch: (input, init) => {
          requested.push(String(input));
          return browser.fetch(input, init);
        },
      });
      const current = async () => ((await api.getConnections()) as { ok: true; value: ConnectionsView }).value;
      return { api, current };
    };

    const { code } = (await adminRequest(directory, { command: "pair" })) as { code: string };
    const first = open(code);
    await until(async () => (await first.current()).status.phase === "pairing_required", "pairing to be required");
    expect((await first.current()).pairingLink).toEqual({ deviceName: "Safari on iPhone" });
    await first.api.activateConnection({ id: "server", deviceName: "Ana's phone" });
    await until(async () => (await first.current()).status.phase === "connected", "the connection");
    expect(server.auth.devices()).toEqual([expect.objectContaining({ name: "Ana's phone" })]);
    expect((await first.current()).pairingLink).toBeUndefined();
    expect(requested.join()).not.toContain(code);

    // The same link again: the code was used, so the person is asked for a new one.
    const second = open(code);
    await until(async () => (await second.current()).pairingLink !== undefined, "the pairing link");
    await second.api.activateConnection({ id: "server", deviceName: "Again" });
    await until(
      async () => /expired, was already used/.test((await second.current()).status.message ?? ""),
      "the refusal",
    );
    expect(await second.current()).toMatchObject({ status: { phase: "pairing_required" } });
    expect((await second.current()).pairingLink).toBeUndefined();
    expect(server.auth.devices()).toHaveLength(1);
  });

  it("takes the pairing code from the link and removes it from history", () => {
    const replaced: string[] = [];
    const history = {
      state: null,
      replaceState: (_: unknown, __: string, url?: string | URL | null) => void replaced.push(String(url)),
    };
    expect(takePairingCode({ hash: "#pair=KD7QX-M2PZR", pathname: "/", search: "" }, history)).toBe("KD7QX-M2PZR");
    expect(replaced).toEqual(["/"]);
    expect(
      takePairingCode({ hash: "#pair=bad%20code&tab=x", pathname: "/a", search: "?q=1" }, history),
    ).toBeUndefined();
    expect(replaced.at(-1)).toBe("/a?q=1#tab=x");
    expect(takePairingCode({ hash: "#tab=x", pathname: "/", search: "" }, history)).toBeUndefined();
    expect(replaced).toHaveLength(2);
  });

  it("names browsers by their user agent", () => {
    expect(browserDeviceName("Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36")).toBe(
      "Chrome on Android",
    );
    expect(browserDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Version/18.0 Safari/605.1.15")).toBe(
      "Safari on Mac",
    );
  });
});
