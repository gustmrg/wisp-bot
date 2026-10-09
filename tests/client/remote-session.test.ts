import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import {
  FatalTransportError,
  RemoteSession,
  type RemoteSessionPhase,
  type RemoteTransport,
} from "../../client/remote-session.js";
import { adminRequest } from "../../server/admin.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function startServer(directory: string, port: number, key: Buffer): Promise<WispServer> {
  const server = await createWispServer({
    dataDirectory: directory,
    host: "127.0.0.1",
    port,
    encryption: new MasterKeyEncryption(key),
    logger: silent,
    agentMode: "fake",
    appVersion: "1.0.0",
    allowModelNetwork: false,
  });
  cleanups.push(() => server.close());
  return server;
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-session-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  const key = randomBytes(32);
  const server = await startServer(directory, port, key);
  return { directory, port, key, server };
}

function session(
  baseUrl: string,
  overrides: { requestPairingCode?: () => Promise<string>; openTransport?: () => Promise<RemoteTransport> } = {},
) {
  let stored: DeviceCredentials | undefined;
  const phases: Array<[RemoteSessionPhase, string | undefined]> = [];
  const events: Array<[string, unknown]> = [];
  let resets = 0;
  const instance = new RemoteSession({
    serverName: "Test server",
    deviceName: "Test device",
    openTransport: async () =>
      overrides.openTransport
        ? overrides.openTransport()
        : {
            baseUrl,
            closed: new Promise(() => undefined),
            close: () => undefined,
            ...(overrides.requestPairingCode ? { requestPairingCode: overrides.requestPairingCode } : {}),
          },
    credentials: {
      load: () => stored,
      save: async (credentials) => {
        stored = credentials;
      },
    },
    onStatus: (phase, message) => phases.push([phase, message]),
    onEvent: (type, payload) => events.push([type, payload]),
    onReset: () => resets++,
    backoffMs: () => 50,
  });
  cleanups.push(() => instance.stop());
  return {
    instance,
    phases,
    events,
    resets: () => resets,
    credentials: () => stored,
    phase: () => phases.at(-1)?.[0],
  };
}

async function waitUntil(probe: () => unknown, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pairCode = async (directory: string) =>
  ((await adminRequest(directory, { command: "pair" })) as { code: string }).code;

describe("RemoteSession", () => {
  it("waits for a pairing code, then connects and reloads once", async () => {
    const { server, directory } = await setup();
    const client = session(server.url);
    client.instance.start(undefined, false);
    await waitUntil(() => client.phase() === "pairing_required", "pairing to be required");
    expect(await client.instance.call("getConversationState", {})).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: true },
    });
    client.instance.start(await pairCode(directory));
    await waitUntil(() => client.phase() === "connected", "the connection");
    expect(client.resets()).toBe(1);
    expect(client.credentials()?.serverId).toBe(server.serverId);
    expect(await client.instance.call("getConversationState", {})).toMatchObject({ ok: true });
  });

  it("pairs over the transport when the user asks, and streams events", async () => {
    const { server, directory } = await setup();
    const client = session(server.url, { requestPairingCode: () => pairCode(directory) });
    client.instance.start();
    await waitUntil(() => client.phase() === "connected", "the connection");
    await client.instance.call("saveAiSettings", {
      selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" },
      apiKey: "test-key",
    });
    await client.instance.call("createWisp", {
      wisp: { id: "atlas", name: "Atlas", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
      notifyOnUpdatesEnabled: true,
    });
    await client.instance.call("sendMessage", { conversationId: "atlas", requestId: "r1", text: "Hi" });
    await waitUntil(
      () =>
        client.events.some(
          ([type, payload]) =>
            type === "agentEvent" && (payload as { type: string }).type === "assistant_message_completed",
        ),
      "the reply",
    );
    expect(client.events.some(([type]) => type === "conversationChanged")).toBe(true);
  });

  it("stops at once while the server does not answer", async () => {
    let requests = 0;
    // A link that accepts requests and never answers them, like a dying tunnel.
    const silentFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        requests++;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const client = session("http://127.0.0.1:9", {
      openTransport: async () => ({
        baseUrl: "http://127.0.0.1:9",
        fetch: silentFetch,
        closed: new Promise(() => undefined),
        close: () => undefined,
      }),
    });
    client.instance.start("ABCDE-FGHJK");
    await waitUntil(() => requests > 0, "the pairing request");
    const started = Date.now();
    await client.instance.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reconnects after the server restarts and asks for a reload", async () => {
    const { server, directory, port, key } = await setup();
    const client = session(server.url, { requestPairingCode: () => pairCode(directory) });
    client.instance.start();
    await waitUntil(() => client.phase() === "connected", "the connection");
    await server.close();
    await waitUntil(() => client.phase() === "reconnecting", "the drop to be noticed");
    expect(await client.instance.call("getConversationState", {})).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    await startServer(directory, port, key);
    await waitUntil(() => client.phase() === "connected" && client.resets() === 2, "the reconnect and resync");
    expect(await client.instance.call("getConversationState", {})).toMatchObject({ ok: true });
  });

  it("stops at pairing after the device is revoked, without pairing again by itself", async () => {
    const { server, directory } = await setup();
    let codes = 0;
    const client = session(server.url, {
      requestPairingCode: () => {
        codes++;
        return pairCode(directory);
      },
    });
    client.instance.start();
    await waitUntil(() => client.phase() === "connected", "the connection");
    await adminRequest(directory, { command: "revoke", deviceId: client.credentials()!.deviceId });
    await waitUntil(() => client.phase() === "pairing_required", "pairing to be required");
    expect(client.credentials()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(codes).toBe(1);
    client.instance.start();
    await waitUntil(() => client.phase() === "connected", "pairing again on request");
    expect(codes).toBe(2);
  });

  it("refuses a server whose identity differs from the one it paired with", async () => {
    const { server, directory } = await setup();
    // Pairing records the real server ID; the impostor then reports another one.
    const impostor: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/api/v1/server")) return response;
      const body = (await response.json()) as { value: { serverId: string } };
      body.value.serverId = "another-server";
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    const client = session("", {
      openTransport: async () => ({
        baseUrl: server.url,
        fetch: impostor,
        closed: new Promise(() => undefined),
        close: () => undefined,
      }),
    });
    client.instance.start(await pairCode(directory));
    await waitUntil(() => client.phase() === "error", "the mismatch");
    expect(client.phases.at(-1)?.[1]).toMatch(/not the server this device paired with/);
    expect(await client.instance.call("getConversationState", {})).toMatchObject({ ok: false });
  });

  it.each([
    [1, /older Wisp server \(1\.0\.0\).*Update the server/],
    [99, /newer Wisp server \(1\.0\.0\).*Update this app/],
  ])("refuses a server that speaks protocol %i", async (protocolVersion, message) => {
    const { server, directory } = await setup();
    const other: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/api/v1/server")) return response;
      const body = (await response.json()) as { value: { protocolVersion: number } };
      body.value.protocolVersion = protocolVersion;
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    const client = session("", {
      openTransport: async () => ({
        baseUrl: server.url,
        fetch: other,
        closed: new Promise(() => undefined),
        close: () => undefined,
      }),
    });
    client.instance.start(await pairCode(directory));
    await waitUntil(() => client.phase() === "error", "the protocol mismatch");
    expect(client.phases.at(-1)?.[1]).toMatch(message);
    expect(client.phases.some(([phase]) => phase === "connected")).toBe(false);
  });

  it("stops cleanly when stopped while its transport is still opening", async () => {
    const { server } = await setup();
    let close = 0;
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = session("", {
      openTransport: async () => {
        await opening;
        return { baseUrl: server.url, closed: new Promise(() => undefined), close: () => close++ };
      },
    });
    client.instance.start();
    const stopped = client.instance.stop();
    release();
    await stopped;
    expect(close).toBe(1);
    expect(client.phase()).not.toBe("connected");
  });

  it("reports transport failures that retrying cannot fix and retries on request", async () => {
    let attempts = 0;
    const client = session("", {
      openTransport: async () => {
        attempts++;
        throw new FatalTransportError("Verify the host key first.");
      },
    });
    client.instance.start();
    await waitUntil(() => client.phase() === "error", "the error");
    expect(client.phases.at(-1)).toEqual(["error", "Verify the host key first."]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(attempts).toBe(1);
    client.instance.start();
    await waitUntil(() => attempts === 2, "the retry");
  });

  it("shows the transport's own reason when the server cannot be reached", async () => {
    const port = await freePort();
    // A paired device goes on to reach the server, which nothing answers for.
    let stored: DeviceCredentials | undefined = {
      deviceId: "d",
      serverId: "s",
      accessToken: "a",
      accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      refreshToken: "r",
    };
    const phases: Array<[RemoteSessionPhase, string | undefined]> = [];
    const paired = new RemoteSession({
      serverName: "Test server",
      deviceName: "Test device",
      openTransport: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        closed: new Promise(() => undefined),
        close: () => undefined,
        explainFailure: () => "Nothing answers on port 8787.",
      }),
      credentials: {
        load: () => stored,
        save: async (credentials) => {
          stored = credentials as DeviceCredentials | undefined;
        },
      },
      onStatus: (phase, message) => phases.push([phase, message]),
      onEvent: () => undefined,
      onReset: () => undefined,
      backoffMs: () => 50,
    });
    cleanups.push(() => paired.stop());
    paired.start(undefined, false);
    await waitUntil(() => phases.length > 0, "a status");
    expect(phases.at(-1)).toEqual(["connecting", "Nothing answers on port 8787."]);
  });
});
