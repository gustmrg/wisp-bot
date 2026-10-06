import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileLogSink } from "../../backend/file-log-sink.js";
import { StructuredLogger } from "../../backend/structured-logger.js";
import { adminRequest } from "../../server/admin.js";
import { runCli } from "../../server/cli.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";
import type { BackendResult } from "../../shared/contracts.js";
import type { Chat } from "../../shared/conversations.js";
import { decodeRemoteJson, encodeRemoteJson } from "../../shared/remote-codec.js";
import type { DeviceCredentials, ServerDescriptor } from "../../shared/remote-protocol.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const directories: string[] = [];
const servers: WispServer[] = [];
const streams: AbortController[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.abort();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const atlas: Chat = {
  id: "atlas",
  name: "Atlas",
  label: "Research",
  description: "",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "2026-10-05T12:00:00.000Z",
  messages: [],
};

interface Harness {
  server: WispServer;
  directory: string;
  key: Buffer;
  advance(ms: number): void;
}

async function start(existing?: Pick<Harness, "directory" | "key">): Promise<Harness> {
  const directory = existing?.directory ?? (await mkdtemp(path.join(os.tmpdir(), "wisp-server-")));
  if (!existing) directories.push(directory);
  const key = existing?.key ?? randomBytes(32);
  let offset = 0;
  const server = await createWispServer({
    dataDirectory: directory,
    host: "127.0.0.1",
    port: 0,
    encryption: new MasterKeyEncryption(key),
    logger: silent,
    agentMode: "fake",
    appVersion: "1.2.3",
    allowModelNetwork: false,
    now: () => Date.now() + offset,
  });
  servers.push(server);
  return {
    server,
    directory,
    key,
    advance: (ms) => {
      offset += ms;
    },
  };
}

async function pair({ server, directory }: Harness, deviceName = "Test device"): Promise<DeviceCredentials> {
  const { code } = (await adminRequest(directory, { command: "pair" })) as { code: string };
  const response = await post(server, "/api/v1/auth/pair", { code, deviceName });
  expect(response.status).toBe(200);
  return (response.body as { value: DeviceCredentials }).value;
}

async function post(server: WispServer, route: string, body: unknown, accessToken?: string) {
  const response = await fetch(`${server.url}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: encodeRemoteJson(body),
  });
  return { status: response.status, body: decodeRemoteJson(await response.text()) };
}

async function rpc<T = unknown>(
  server: WispServer,
  credentials: DeviceCredentials,
  operation: string,
  payload?: unknown,
): Promise<BackendResult<T>> {
  const response = await post(server, `/api/v1/rpc/${operation}`, payload ?? {}, credentials.accessToken);
  expect(response.status).toBe(200);
  return response.body as BackendResult<T>;
}

interface StreamEvent {
  id?: string;
  type: string;
  data: unknown;
}

/** Opens the event stream and collects parsed events until the test ends. */
async function openEvents(server: WispServer, credentials: DeviceCredentials, lastEventId?: string) {
  const controller = new AbortController();
  streams.push(controller);
  const response = await fetch(`${server.url}/api/v1/events`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const events: StreamEvent[] = [];
  let ended = false;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const fields = new Map<string, string>();
          for (const line of block.split("\n")) {
            const separator = line.indexOf(": ");
            if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 2));
          }
          const type = fields.get("event");
          if (type) {
            events.push({ id: fields.get("id"), type, data: decodeRemoteJson(fields.get("data") ?? "null") });
          }
        }
      }
    } catch {
      // Aborted by the test.
    }
    ended = true;
  })();
  return {
    events,
    ended: () => ended,
    waitFor: (predicate: (event: StreamEvent) => boolean) =>
      waitUntil(() => events.find(predicate), "a matching server event"),
  };
}

async function waitUntil<T>(probe: () => T | undefined | false, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function rawRequest(server: WispServer, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${server.url}/health`, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

async function setUpWisp(server: WispServer, credentials: DeviceCredentials): Promise<void> {
  expect(
    await rpc(server, credentials, "saveAiSettings", {
      selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" },
      apiKey: "test-key",
    }),
  ).toMatchObject({ ok: true });
  expect(await rpc(server, credentials, "createConversation", { conversation: atlas })).toMatchObject({ ok: true });
}

describe("Wisp server", () => {
  it("starts when a log line created its folders first", async () => {
    // A warning logged before the server starts, such as a missing master key, creates backend/logs.
    const directory = path.join(await mkdtemp(path.join(os.tmpdir(), "wisp-logs-first-")), "data");
    directories.push(path.dirname(directory));
    const sink = new FileLogSink(path.join(directory, "backend", "logs"));
    sink.warn("early warning");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const server = await createWispServer({
      dataDirectory: directory,
      host: "127.0.0.1",
      port: 0,
      encryption: new MasterKeyEncryption(),
      logger: silent,
      agentMode: "fake",
      appVersion: "1.0.0",
      allowModelNetwork: false,
    });
    servers.push(server);
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it("answers health checks but requires a paired device for the API", async () => {
    const { server } = await start();
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    expect((await post(server, "/api/v1/rpc/getConversationState", {})).status).toBe(401);
    expect((await post(server, "/api/v1/rpc/getConversationState", {}, "made-up-token")).status).toBe(401);
    expect((await fetch(`${server.url}/api/v1/events`)).status).toBe(401);
    expect((await post(server, "/api/v1/auth/pair", { code: "WRONG-CODES", deviceName: "x" })).status).toBe(401);
  });

  it("refuses foreign host names and browser origins", async () => {
    const { server } = await start();
    expect(await rawRequest(server, { Host: "attacker.example:80" })).toBe(403);
    expect(await rawRequest(server, { Origin: "https://attacker.example" })).toBe(403);
    expect(await rawRequest(server, { Host: `localhost:${server.port}` })).toBe(200);
    // A tunnel forwards from another local port.
    expect(await rawRequest(server, { Host: "127.0.0.1:40001" })).toBe(200);
    expect(await rawRequest(server, { Host: "[::1]:9" })).toBe(200);
    expect(await rawRequest(server, { Host: "127.0.0.1.attacker.example:80" })).toBe(403);
  });

  it("describes itself to paired devices with only the operations it serves", async () => {
    const harness = await start();
    const credentials = await pair(harness);
    expect(credentials.serverId).toBe(harness.server.serverId);
    const response = await fetch(`${harness.server.url}/api/v1/server`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    const descriptor = ((await response.json()) as { value: ServerDescriptor }).value;
    expect(descriptor).toMatchObject({ protocolVersion: 1, serverId: harness.server.serverId, version: "1.2.3" });
    expect(descriptor.operations).toEqual(
      expect.arrayContaining(["createConversation", "sendMessage", "getMcpSettings", "transcribeAudio", "listSkills"]),
    );
    for (const desktopOnly of ["checkForUpdates", "getLaunchAtLoginState", "openReleasesPage", "agentEvent"]) {
      expect(descriptor.operations).not.toContain(desktopOnly);
      expect((await post(harness.server, `/api/v1/rpc/${desktopOnly}`, {}, credentials.accessToken)).status).toBe(404);
    }
  });

  it("runs a conversation and streams its events to every connected device", async () => {
    const harness = await start();
    const laptop = await pair(harness, "Laptop");
    const phone = await pair(harness, "Phone");
    await setUpWisp(harness.server, laptop);
    const laptopEvents = await openEvents(harness.server, laptop);
    const phoneEvents = await openEvents(harness.server, phone);

    expect(await rpc(harness.server, laptop, "startConversation", { conversationId: "atlas" })).toEqual({
      ok: true,
      value: {},
    });
    expect(
      await rpc(harness.server, laptop, "sendMessage", { conversationId: "atlas", requestId: "request-1", text: "Hi" }),
    ).toEqual({ ok: true, value: {} });

    for (const stream of [laptopEvents, phoneEvents]) {
      await stream.waitFor(
        (event) =>
          event.type === "agentEvent" && (event.data as { type: string }).type === "assistant_message_completed",
      );
      await stream.waitFor((event) => event.type === "conversationChanged");
    }
    const page = await rpc<{ messages: Array<{ type: string }> }>(harness.server, phone, "getConversationMessages", {
      conversationId: "atlas",
      page: "latest",
    });
    expect(page.ok && page.value.messages.some((message) => message.type === "incoming")).toBe(true);
    // Retrying a request whose answer was lost never runs it twice.
    expect(
      await rpc(harness.server, laptop, "sendMessage", { conversationId: "atlas", requestId: "request-1", text: "Hi" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringMatching(/already been accepted/) },
    });
  });

  it("replays missed events after a reconnect and asks stale clients to resync", async () => {
    const harness = await start();
    const credentials = await pair(harness);
    await setUpWisp(harness.server, credentials);
    const first = await openEvents(harness.server, credentials);
    await rpc(harness.server, credentials, "updateConversation", { conversationId: "atlas", changes: { name: "A" } });
    await rpc(harness.server, credentials, "markConversationRead", { conversationId: "atlas" });
    await rpc(harness.server, credentials, "sendMessage", { conversationId: "atlas", requestId: "r1", text: "Hi" });
    const seen = await first.waitFor((event) => event.type === "agentEvent");

    const resumed = await openEvents(harness.server, credentials, seen.id);
    const replayed = await resumed.waitFor((event) => event.type === "conversationChanged");
    expect(resumed.events[0]?.id).not.toBe(seen.id);
    expect(replayed).toBeTruthy();

    const stale = await openEvents(harness.server, credentials, "another-boot:12");
    const resync = await stale.waitFor((event) => event.type === "resync");
    expect(stale.events[0]).toBe(resync);
    expect(resync.id).toMatch(/:\d+$/);
  });

  it("keeps an event stream open when the access token expires, and refreshes for new requests", async () => {
    const harness = await start();
    const credentials = await pair(harness);
    await setUpWisp(harness.server, credentials);
    const stream = await openEvents(harness.server, credentials);
    harness.advance(16 * 60_000);
    expect((await post(harness.server, "/api/v1/rpc/getConversationState", {}, credentials.accessToken)).status).toBe(
      401,
    );
    const refreshed = (
      (await post(harness.server, "/api/v1/auth/refresh", { refreshToken: credentials.refreshToken })).body as {
        value: DeviceCredentials;
      }
    ).value;
    await rpc(harness.server, refreshed, "sendMessage", { conversationId: "atlas", requestId: "r1", text: "Hi" });
    await stream.waitFor((event) => event.type === "agentEvent");
    expect(stream.ended()).toBe(false);
  });

  it("ends a revoked device's stream and rejects its tokens", async () => {
    const harness = await start();
    const credentials = await pair(harness);
    const stream = await openEvents(harness.server, credentials);
    await adminRequest(harness.directory, { command: "revoke", deviceId: credentials.deviceId });
    await waitUntil(() => stream.ended(), "the stream to end");
    expect((await post(harness.server, "/api/v1/rpc/getConversationState", {}, credentials.accessToken)).status).toBe(
      401,
    );
    expect(
      (await post(harness.server, "/api/v1/auth/refresh", { refreshToken: credentials.refreshToken })).status,
    ).toBe(401);
    await expect(adminRequest(harness.directory, { command: "revoke", deviceId: "unknown" })).rejects.toThrow(
      /No paired device/,
    );
  });

  it("carries recorded audio and reports what a server host cannot do", async () => {
    const harness = await start();
    const credentials = await pair(harness);
    await setUpWisp(harness.server, credentials);
    await rpc(harness.server, credentials, "saveVoiceCredential", { providerId: "groq", apiKey: "test-key" });
    expect(
      await rpc(harness.server, credentials, "transcribeAudio", {
        providerId: "groq",
        modelId: "whisper-large-v3-turbo",
        language: "auto",
        mimeType: "audio/webm",
        audio: new Uint8Array([1, 2, 3]),
      }),
    ).toEqual({ ok: true, value: { text: "This is a fake transcription." } });
    expect(await rpc(harness.server, credentials, "openWorkspaceFolder", { conversationId: "atlas" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    const tooLarge = await post(
      harness.server,
      "/api/v1/rpc/appendConversationMessage",
      { text: "x".repeat(3 * 1024 * 1024) },
      credentials.accessToken,
    );
    expect(tooLarge.status).toBe(413);
  });

  it("owns its data directory exclusively and keeps state across restarts", async () => {
    const first = await start();
    const credentials = await pair(first);
    await setUpWisp(first.server, credentials);
    await expect(start({ directory: first.directory, key: first.key })).rejects.toThrow(/already using/);
    await first.server.close();

    const second = await start({ directory: first.directory, key: first.key });
    expect(second.server.serverId).toBe(first.server.serverId);
    expect((await post(second.server, "/api/v1/rpc/getConversationState", {}, credentials.accessToken)).status).toBe(
      401,
    );
    const refreshed = (
      (await post(second.server, "/api/v1/auth/refresh", { refreshToken: credentials.refreshToken })).body as {
        value: DeviceCredentials;
      }
    ).value;
    const state = await rpc<{ chats: Record<string, Chat> }>(second.server, refreshed, "getConversationState");
    expect(state.ok && Object.keys(state.value.chats)).toEqual(["atlas"]);
    expect(await rpc(second.server, refreshed, "getAiSettings")).toMatchObject({
      ok: true,
      value: { selection: { providerId: "openrouter" } },
    });
  });

  it("serves the administrative CLI over the owner-only socket", async () => {
    const harness = await start();
    const output: string[] = [];
    const cli = (...args: string[]) =>
      runCli([...args, "--data-dir", harness.directory, "--json"], (text) => output.push(text));
    await cli("pair");
    const { code } = JSON.parse(output.pop()!) as { code: string };
    await post(harness.server, "/api/v1/auth/pair", { code, deviceName: "From CLI" });
    await cli("devices");
    expect(JSON.parse(output.pop()!)).toEqual([expect.objectContaining({ name: "From CLI" })]);
    await cli("status");
    expect(JSON.parse(output.pop()!)).toMatchObject({ serverId: harness.server.serverId, devices: 1 });
    await expect(
      runCli(["status", "--data-dir", path.join(harness.directory, "missing")], () => undefined),
    ).rejects.toThrow(/No Wisp server is running/);
  });
});
