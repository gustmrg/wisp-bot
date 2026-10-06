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
import type { Chat } from "../../shared/conversations.js";
import { isWispBridgeAvailable } from "../../src/lib/wisp-bridge.js";
import { browserDeviceName, createWebWispApi } from "../../src/web/web-api.js";

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

const atlas: Chat = {
  id: "atlas",
  name: "Atlas",
  label: "",
  description: "",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "",
  timestamp: "2026-10-05T12:00:00.000Z",
  messages: [],
};

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
    const api = createWebWispApi({
      origin: server.url,
      storage,
      deviceName: browserDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1"),
      appVersion: "1.0.0",
      fetch: browser.fetch,
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
    expect(await api.createConversation({ conversation: atlas })).toMatchObject({ ok: true });
    await api.sendMessage({ conversationId: "atlas", requestId: "r1", text: "Hi" });
    await until(() => events.includes("assistant_message_completed"), "the reply");

    // Desktop-only actions explain themselves instead of failing silently.
    expect(await api.checkForUpdates()).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await api.saveConnection({ kind: "url", name: "x", url: "https://x" })).toMatchObject({ ok: false });
    expect(await api.openWorkspaceFolder({ conversationId: "atlas" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });

    await api.removeConnection({ id: "server" });
    await until(async () => (await phase()) === "pairing_required", "signing out");
    expect(server.auth.devices()).toEqual([]);
    expect(storage.values.size).toBe(0);
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
