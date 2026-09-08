import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStreamParser } from "../client/event-stream.js";
import { RemoteBackendClient, validateRemoteEndpoint } from "../client/remote-backend-client.js";
import type { RemoteServerDescriptor, RemoteSnapshot } from "../shared/remote-protocol.js";

const descriptor: RemoteServerDescriptor = {
  protocolVersion: 1,
  serverId: "server-one",
  bootId: "boot-one",
  version: "1.0.0",
  owner: { id: "owner-one", name: "Owner" },
  capabilities: [],
  limits: { maxPendingPerConversation: 8, maxRunning: 4, maxMessageBytes: 131072 },
};
const snapshot: RemoteSnapshot = {
  serverId: descriptor.serverId,
  bootId: descriptor.bootId,
  cursor: "generation:42",
  revision: 42,
  revisions: { chat: 7 },
  settingsRevision: 3,
  state: {
    initialized: true,
    chats: {},
    statuses: {},
    agentEventSequence: 42,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
  },
};
const credentials = {
  accessToken: "secret-access",
  refreshToken: "secret-refresh",
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  deviceId: "device-one",
  serverId: descriptor.serverId,
};
const success = (value: unknown): Response => Response.json({ ok: true, value });
const clients: RemoteBackendClient[] = [];
afterEach(() => {
  for (const client of clients) client.disconnect();
  clients.length = 0;
  vi.useRealTimers();
});
function setup(override?: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined) {
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const custom = await override?.(url, init);
    if (custom) return custom;
    if (url.pathname.endsWith("/server")) return success(descriptor);
    if (url.pathname.endsWith("/snapshot")) return success(snapshot);
    if (url.pathname.endsWith("/auth/session")) return success({ ...credentials, csrfToken: "csrf-secret" });
    if (url.pathname.endsWith("/auth/refresh"))
      return success({ ...credentials, accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    if (url.pathname.endsWith("/events"))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    return success({});
  });
  const client = new RemoteBackendClient({
    baseUrl: "https://wisp.tailnet.ts.net",
    auth: { kind: "bearer", credentials },
    fetch: fetcher,
  });
  clients.push(client);
  return { client, requests, fetcher, emit: (text: string) => stream.enqueue(new TextEncoder().encode(text)) };
}
describe("remote client", () => {
  it("hydrates authoritative state before opening an authenticated event stream", async () => {
    const { client, requests, emit } = setup();
    const snapshots = vi.fn();
    const events = vi.fn();
    client.subscribeToSnapshot(snapshots);
    client.api.subscribeToAgentEvents(events);
    await client.connect();
    expect(snapshots).toHaveBeenCalledWith(snapshot);
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/v1/server", "/api/v1/snapshot", "/api/v1/events"]);
    expect(requests[2]!.url.searchParams.get("after")).toBe("generation:42");
    expect(new Headers(requests[2]!.init?.headers).get("Authorization")).toBe("Bearer secret-access");
    expect(requests.every((r) => !r.url.href.includes("secret"))).toBe(true);
    emit(
      `event: wisp\nid: generation:43\ndata: ${JSON.stringify({ protocolVersion: 1, serverId: descriptor.serverId, bootId: descriptor.bootId, eventId: "generation:43", type: "agent", occurredAt: new Date().toISOString(), payload: { type: "conversation_status", conversationId: "chat", status: "working", sequence: 43 } })}\n\n`,
    );
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1));
    expect(client.getState().phase).toBe("connected");
  });
  it("checks uncertain message admission without automatically resending a command", async () => {
    const { client, requests } = setup((url) => {
      if (url.pathname.endsWith("/messages")) throw new TypeError("Network lost after admission");
      if (url.pathname.includes("/requests/"))
        return success({ requestId: "request-1", status: "running", revision: 8 });
    });
    await client.connect();
    const result = await client.api.sendMessage({ conversationId: "chat", requestId: "request-1", text: "hello" });
    expect(result.ok).toBe(true);
    expect(requests.filter((request) => request.url.pathname.endsWith("/messages"))).toHaveLength(1);
    expect(requests.filter((request) => request.url.pathname.includes("/requests/"))).toHaveLength(1);
  });
  it("carries the current revision and refuses commands after disconnect", async () => {
    const { client, requests } = setup();
    await client.connect();
    await client.api.updateConversation({ conversationId: "chat", changes: { kind: "wisp", name: "Updated" } });
    const mutation = requests.find((r) => r.init?.method === "PATCH");
    expect(JSON.parse(mutation!.init!.body as string).expectedRevision).toBe(7);
    const count = requests.length;
    client.disconnect();
    expect((await client.api.sendMessage({ conversationId: "chat", requestId: "request-2", text: "hello" })).ok).toBe(
      false,
    );
    expect(requests).toHaveLength(count);
  });
  it("pins server identity before fetching conversations or accepting another pairing", async () => {
    const { client, requests } = setup((url) =>
      url.pathname.endsWith("/server") ? success({ ...descriptor, serverId: "other-server" }) : undefined,
    );
    await expect(client.connect()).rejects.toMatchObject({ code: "server_identity_changed" });
    expect(requests).toHaveLength(1);
  });
  it("keeps an editor's loaded revision after a newer shared snapshot arrives", async () => {
    let current = snapshot;
    const { client, requests } = setup((url, init) => {
      if (url.pathname.endsWith("/snapshot")) return success(current);
      if (init?.method === "PATCH")
        return Response.json(
          { ok: false, error: { code: "conflict", message: "Reload the changed conversation.", retryable: false } },
          { status: 409 },
        );
    });
    await client.connect();
    const loadedRevision = 7;
    current = { ...snapshot, revisions: { chat: 9 }, settingsRevision: 5 };
    await client.api.getConversationState();
    const result = await client.api.updateConversation({
      conversationId: "chat",
      expectedRevision: loadedRevision,
      changes: { kind: "wisp", name: "Old draft" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      JSON.parse(requests.find((value) => value.init?.method === "PATCH")!.init!.body as string).expectedRevision,
    ).toBe(loadedRevision);
    await client.api.saveToolPolicy({ autoReview: false, rules: [], revision: 3 });
    expect(
      JSON.parse(requests.find((value) => value.url.pathname.endsWith("/tool-policy"))!.init!.body as string)
        .expectedRevision,
    ).toBe(3);
  });
  it("reconciles a second committed event that arrives during a snapshot read", async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const { client, emit } = setup((url) => {
      if (!url.pathname.endsWith("/snapshot")) return;
      reads++;
      if (reads === 1) return success(snapshot);
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          release = () => resolve(success({ ...snapshot, revision: 43, cursor: "generation:43" }));
        });
      return success({ ...snapshot, revision: 44, cursor: "generation:44" });
    });
    await client.connect();
    const change = (sequence: number) =>
      `event: wisp\nid: generation:${sequence}\ndata: ${JSON.stringify({ protocolVersion: 1, serverId: descriptor.serverId, eventId: `generation:${sequence}`, type: "state_changed", payload: {} })}\n\n`;
    emit(change(43));
    await vi.waitFor(() => expect(release).toBeDefined());
    emit(change(44));
    // Wait for both stream frames to be consumed while the first response is held.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release!();
    await vi.waitFor(() => expect(client.getSnapshot()?.revision).toBe(44));
    expect(reads).toBe(3);
  });
  it("blocks incompatible major versions before loading state", async () => {
    const { client, requests } = setup((url) =>
      url.pathname.endsWith("/server") ? success({ ...descriptor, protocolVersion: 2 }) : undefined,
    );
    await expect(client.connect()).rejects.toMatchObject({ code: "protocol_incompatible" });
    expect(requests).toHaveLength(1);
  });
  it("rotates an expired token once on an unauthorized read", async () => {
    let first = true;
    const { client, requests } = setup((url) => {
      if (url.pathname.endsWith("/server") && first) {
        first = false;
        return Response.json(
          { ok: false, error: { code: "unauthorized", message: "Expired", retryable: false } },
          { status: 401 },
        );
      }
    });
    await client.connect();
    expect(requests.filter((r) => r.url.pathname.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(new Headers(requests.at(-1)!.init!.headers).get("Authorization")).toBe("Bearer rotated-access");
  });
  it("does not dispose remote agents or import local conversations on teardown", async () => {
    const { client, requests } = setup();
    await client.connect();
    await client.api.disposeConversation({ conversationId: "chat" });
    await client.api.initializeConversations({ chats: { untrusted: "local history" } });
    client.disconnect();
    expect(requests.every((r) => (r.init?.method ?? "GET") === "GET")).toBe(true);
  });
  it("allows HTTP only for explicitly enabled loopback tunnels", () => {
    expect(() => validateRemoteEndpoint("http://100.64.0.1:8787", true)).toThrow();
    expect(() => validateRemoteEndpoint("http://127.0.0.1:8787")).toThrow();
    expect(validateRemoteEndpoint("http://127.0.0.1:8787", true)).toBe("http://127.0.0.1:8787");
    for (const value of ["https://token@host", "https://host/path", "https://host?token=secret"])
      expect(() => validateRemoteEndpoint(value)).toThrow();
  });
});
describe("SSE parser", () => {
  it("handles chunked CRLF, heartbeats, multi-line payloads and UTF-8 text", () => {
    const emit = vi.fn();
    const parser = new EventStreamParser(emit);
    for (const part of [": heartbeat\r", "\nevent: wi", "sp\r\nid: opaque-1\r\ndata: olá\r\ndata: mundo\r\n", "\r\n"])
      parser.push(part);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ event: "wisp", id: "opaque-1", data: "olá\nmundo" });
  });
  it("bounds incomplete and multi-line event frames", () => {
    const parser = new EventStreamParser(vi.fn(), 50);
    expect(() => parser.push("x".repeat(51))).toThrow();
    const multiline = new EventStreamParser(vi.fn(), 50);
    multiline.push("data: " + "x".repeat(20) + "\n");
    expect(() => multiline.push("data: " + "x".repeat(20) + "\n")).toThrow();
  });
});
