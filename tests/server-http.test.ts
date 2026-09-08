import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWispServer, type WispServer } from "../server/application.js";
import { adminRequest } from "../server/admin.js";
import type { DeviceCredentials } from "../server/auth/device-auth.js";

const servers: WispServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const chat = (id = "first") => ({
  id,
  kind: "wisp",
  shape: "circle",
  name: id,
  label: "Test",
  description: "Remote test",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
});
async function start(): Promise<WispServer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-http-"));
  directories.push(directory);
  const server = await createWispServer({ dataDirectory: directory, agentMode: "fake", fakeLatencyMs: 5, port: 0 });
  servers.push(server);
  return server;
}
async function pair(server: WispServer): Promise<DeviceCredentials> {
  const response = await fetch(`${server.url}/api/v1/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: server.auth.createPairingCode().code, deviceName: "Integration test" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).value;
}
async function call(
  server: WispServer,
  token: string,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}/api/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the durable request.");
}

describe("headless HTTP server", () => {
  it("admits once when an ACK is lost, shares the final history, and survives restart", async () => {
    let server = await start();
    const directory = server.database.directory;
    const credentials = await pair(server);
    expect(
      (await call(server, credentials.accessToken, "/conversations", "POST", { conversation: chat() })).status,
    ).toBe(201);
    const payload = { requestId: "request-1", text: "Persist this response" };
    const first = await call(server, credentials.accessToken, "/conversations/first/messages", "POST", payload);
    const duplicate = await call(server, credentials.accessToken, "/conversations/first/messages", "POST", payload);
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(
      (
        await call(server, credentials.accessToken, "/conversations/first/messages", "POST", {
          ...payload,
          text: "Different",
        })
      ).status,
    ).toBe(409);
    await until(
      async () =>
        (await call(server, credentials.accessToken, "/conversations/first/requests/request-1")).body.value.status ===
        "completed",
    );
    const second = await pair(server);
    const messages = (await call(server, second.accessToken, "/conversations/first/messages")).body.value.messages;
    expect(messages.filter((message: any) => message.type === "outgoing")).toHaveLength(1);
    expect(messages.filter((message: any) => message.type === "incoming")).toHaveLength(1);
    expect(messages.find((message: any) => message.type === "incoming").status).toBe("complete");
    const identity = server.database.serverId;
    const boot = server.database.bootId;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    server = await createWispServer({ dataDirectory: directory, agentMode: "fake", port: 0 });
    servers.push(server);
    expect(server.database.serverId).toBe(identity);
    expect(server.database.bootId).not.toBe(boot);
    expect((await call(server, credentials.accessToken, "/conversations/first/messages")).body.value.messages).toEqual(
      messages,
    );
    expect(
      (await call(server, credentials.accessToken, "/conversations/first/messages", "POST", payload)).body.value.status,
    ).toBe("completed");
  });

  it("replays committed SSE events and revocation closes an active stream", async () => {
    const server = await start();
    const credentials = await pair(server);
    const snapshot = (await call(server, credentials.accessToken, "/snapshot")).body.value;
    await call(server, credentials.accessToken, "/conversations", "POST", { conversation: chat() });
    const response = await fetch(`${server.url}/api/v1/events?after=${encodeURIComponent(snapshot.cursor)}`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let replayed = "";
    for (let count = 0; count < 32 && !replayed.includes('"type":"state_changed"'); count++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      replayed += new TextDecoder().decode(chunk.value);
    }
    expect(replayed).toContain('"type":"state_changed"');
    server.auth.revoke(credentials.deviceId);
    let ended = false;
    for (let count = 0; count < 20; count++) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
    }
    expect(ended).toBe(true);
    expect((await call(server, credentials.accessToken, "/snapshot")).status).toBe(401);
  });

  it("requires revision checks and rejects accidental imports, raw append, and remote disposal", async () => {
    const server = await start();
    const credentials = await pair(server);
    await call(server, credentials.accessToken, "/conversations", "POST", { conversation: chat() });
    const snapshot = (await call(server, credentials.accessToken, "/snapshot")).body.value;
    expect(snapshot.state.chats.first.revision).toBe(snapshot.revisions.first);
    expect((await call(server, credentials.accessToken, "/conversations/first/model")).body.value.revision).toBe(
      snapshot.revisions.first,
    );
    const update = { changes: { kind: "wisp", name: "Updated" }, expectedRevision: snapshot.revisions.first };
    expect((await call(server, credentials.accessToken, "/conversations/first", "PATCH", update)).status).toBe(200);
    expect((await call(server, credentials.accessToken, "/conversations/first", "PATCH", update)).status).toBe(409);
    for (const route of ["/initialize", "/conversations/first/dispose", "/conversations/first/append"])
      expect((await call(server, credentials.accessToken, route, "POST", {})).status).toBe(404);
  });

  it("returns the revision captured by settings editors and rejects a stale submitted revision", async () => {
    const server = await start();
    const credentials = await pair(server);
    const ai = (await call(server, credentials.accessToken, "/settings/ai")).body.value;
    const policy = (await call(server, credentials.accessToken, "/tool-policy")).body.value;
    expect(ai.revision).toBe(policy.revision);
    const saved = await call(server, credentials.accessToken, "/tool-policy", "PUT", {
      settings: { autoReview: false, rules: [] },
      expectedRevision: policy.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.value.revision).toBeGreaterThan(policy.revision);
    const stale = await call(server, credentials.accessToken, "/settings/ai", "PUT", {
      selection: { providerId: "fake", modelId: "deterministic" },
      expectedRevision: ai.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
  });

  it("bounds payloads and validates authentication, host, origin, and protocol", async () => {
    const server = await start();
    const credentials = await pair(server);
    expect((await fetch(`${server.url}/api/v1/snapshot`)).status).toBe(401);
    const badHost = await new Promise<number>((resolve) => {
      const request = httpRequest(`${server.url}/health/live`, { headers: { Host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.end();
    });
    expect(badHost).toBe(403);
    expect(
      (
        await fetch(`${server.url}/api/v1/snapshot`, {
          headers: { Authorization: `Bearer ${credentials.accessToken}`, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${server.url}/api/v2/snapshot`, {
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(server, credentials.accessToken, "/conversations", "POST", { text: "x".repeat(140_000) })).status,
    ).toBe(413);
    const unpaired = await fetch(`${server.url}/api/v1/snapshot`, {
      headers: { "Tailscale-User-Login": "owner@example.com", "X-Forwarded-User": "owner" },
    });
    expect(unpaired.status).toBe(401);
  });

  it("uses private admin pairing and single-use codes", async () => {
    const server = await start();
    const code = (await adminRequest(server.database.directory, { command: "pair" })) as { code: string };
    expect((await stat(path.join(server.database.directory, "admin.sock"))).mode & 0o777).toBe(0o600);
    const request = () =>
      fetch(`${server.url}/api/v1/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.code, deviceName: "Paired" }),
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(401);
    const raw = await readFile(path.join(server.database.directory, "wisp.sqlite"));
    expect(raw.includes(Buffer.from(code.code))).toBe(false);
    expect(
      () =>
        new (server.database.constructor as typeof import("../server/storage/database.js").ServerDatabase)(
          server.database.directory,
        ),
    ).toThrow("Another server owns");
  });

  it("sets HttpOnly cookies, keeps tokens out of web responses, and requires CSRF", async () => {
    const server = await start();
    const code = server.auth.createPairingCode().code;
    const response = await fetch(`${server.url}/api/v1/auth/pair`, {
      method: "POST",
      headers: { Origin: server.url, "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Browser", mode: "web" }),
    });
    const value = (await response.json()).value;
    expect(value.accessToken).toBeUndefined();
    expect(value.refreshToken).toBeUndefined();
    expect(value.csrfToken).toBeTypeOf("string");
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.every((cookie) => cookie.includes("HttpOnly") && cookie.includes("SameSite=Strict"))).toBe(true);
    const cookie = setCookies.map((item) => item.split(";")[0]).join("; ");
    const headers = { Origin: server.url, Cookie: cookie, "Content-Type": "application/json" };
    const mutate = (csrf?: string) =>
      fetch(`${server.url}/api/v1/conversations`, {
        method: "POST",
        headers: { ...headers, ...(csrf ? { "X-Wisp-CSRF": csrf } : {}) },
        body: JSON.stringify({ conversation: chat() }),
      });
    expect((await mutate()).status).toBe(403);
    expect((await mutate(value.csrfToken)).status).toBe(201);
    const refreshed = await fetch(`${server.url}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { ...headers, "X-Wisp-CSRF": value.csrfToken },
      body: "{}",
    });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).value.accessToken).toBeUndefined();
  });

  it("supports explicitly allowed native HTTPS pairing and preflight while rejecting native cookies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-native-"));
    directories.push(directory);
    const server = await createWispServer({
      dataDirectory: directory,
      agentMode: "fake",
      port: 0,
      admin: false,
      allowedOrigins: ["capacitor://localhost", "https://localhost"],
    });
    servers.push(server);
    for (const origin of ["capacitor://localhost", "https://localhost"]) {
      const headers = { Origin: origin, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" };
      const preflight = await fetch(`${server.url}/api/v1/auth/pair`, { method: "OPTIONS", headers });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      const paired = await fetch(`${server.url}/api/v1/auth/pair`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "token", code: server.auth.createPairingCode().code, deviceName: "Native" }),
      });
      expect(paired.status).toBe(200);
      const credentials = (await paired.json()).value;
      const snapshot = await fetch(`${server.url}/api/v1/snapshot`, {
        headers: { ...headers, Authorization: `Bearer ${credentials.accessToken}` },
      });
      expect(snapshot.status).toBe(200);
      const cookie = await fetch(`${server.url}/api/v1/snapshot`, {
        headers: { ...headers, Cookie: `wisp_access=${credentials.accessToken}` },
      });
      expect(cookie.status).toBe(403);
      const web = await fetch(`${server.url}/api/v1/auth/pair`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "web", code: server.auth.createPairingCode().code, deviceName: "Invalid" }),
      });
      expect(web.status).toBe(403);
    }
  });

  it("accepts one approval decision across devices and persists the deciding device", async () => {
    const server = await start();
    const first = await pair(server),
      second = await pair(server);
    await call(server, first.accessToken, "/conversations", "POST", { conversation: chat() });
    const action = server.backend.toolAuthorization.authorize({
      conversationId: "first",
      toolCallId: "tool-1",
      toolName: "write",
      category: "create_file",
      summary: "Create file",
      scope: { kind: "workspace_path", value: "notes.txt" },
    });
    const pending = server.backend.toolAuthorization.listPending()[0]!;
    expect(server.database.sql.prepare("SELECT state FROM approvals WHERE id=?").get(pending.approvalId)?.state).toBe(
      "pending",
    );
    const body = { conversationId: "first", toolCallId: "tool-1", decision: "allow_once" };
    const responses = await Promise.all([
      call(server, first.accessToken, `/approvals/${pending.approvalId}/resolve`, "POST", body),
      call(server, second.accessToken, `/approvals/${pending.approvalId}/resolve`, "POST", body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    await action;
    const saved = server.database.sql
      .prepare("SELECT state,device_id FROM approvals WHERE id=?")
      .get(pending.approvalId);
    expect(saved?.state).toBe("allow_once");
    expect([first.deviceId, second.deviceId]).toContain(saved?.device_id);
  });
});
