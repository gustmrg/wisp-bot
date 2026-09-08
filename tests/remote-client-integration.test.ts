import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWispServer, type WispServer } from "../server/application.js";
import { RemoteBackendClient } from "../client/remote-backend-client.js";
import type { DeviceCredentials } from "../shared/remote-protocol.js";
import type { Chat } from "../shared/conversations.js";

const clients: RemoteBackendClient[] = [];
const servers: WispServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const chat: Chat = {
  id: "remote-test-chat",
  name: "Remote test",
  label: "Test",
  description: "Test",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "Now",
  messages: [],
  kind: "wisp",
  shape: "circle",
};
async function server(): Promise<WispServer> {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "wisp-client-integration-"));
  directories.push(dataDirectory);
  const value = await createWispServer({ dataDirectory, port: 0, agentMode: "fake", fakeLatencyMs: 5, admin: false });
  servers.push(value);
  return value;
}
async function device(server: WispServer) {
  let credentials: DeviceCredentials | undefined;
  const client = new RemoteBackendClient({
    baseUrl: server.url,
    allowLoopbackHttp: true,
    auth: {
      kind: "bearer",
      onCredentials: (value) => {
        credentials = value;
      },
    },
  });
  clients.push(client);
  await client.pair(server.auth.createPairingCode().code, "Integration device");
  await client.connect();
  return { client, credentials: () => credentials };
}
describe("shared remote client against a real fake-agent HTTP server", () => {
  it("synchronizes edits and messages between devices, including work completed after disconnect", async () => {
    const instance = await server();
    const one = await device(instance);
    const two = await device(instance);
    expect((await one.client.api.createConversation({ conversation: chat })).ok).toBe(true);
    await vi.waitFor(() => expect(two.client.getSnapshot()?.state.chats[chat.id]?.name).toBe(chat.name));
    const message = { conversationId: chat.id, requestId: "durable-request-one", text: "Continue while disconnected" };
    expect(await one.client.api.sendMessage(message)).toEqual({ ok: true, value: {} });
    one.client.disconnect();
    await vi.waitFor(
      async () =>
        expect(await two.client.getRequest(chat.id, message.requestId)).toMatchObject({
          ok: true,
          value: { status: "completed" },
        }),
      { timeout: 10000 },
    );
    await one.client.connect();
    const restored = one.client.getSnapshot()!.state.chats[chat.id]!;
    expect(restored.messages.filter((entry) => entry.type === "outgoing")).toHaveLength(1);
    expect(
      restored.messages.some(
        (entry) => entry.type === "incoming" && entry.text.includes("Continue while disconnected"),
      ),
    ).toBe(true);
    expect((await one.client.api.sendMessage(message)).ok).toBe(true);
    expect(
      one.client.getSnapshot()!.state.chats[chat.id]!.messages.filter((entry) => entry.type === "outgoing"),
    ).toHaveLength(1);
    const conflict = await one.client.api.sendMessage({ ...message, text: "Different payload" });
    expect(conflict).toMatchObject({ ok: false, error: { code: "conflict" } });
  }, 20000);
  it("rejects a revoked device and keeps a second device connected", async () => {
    const instance = await server();
    const one = await device(instance);
    const two = await device(instance);
    instance.auth.revoke(one.credentials()!.deviceId);
    const result = await one.client.api.getAiSettings();
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect((await two.client.api.getAiSettings()).ok).toBe(true);
    expect(
      (await one.client.api.sendMessage({ conversationId: chat.id, requestId: "after-revoke", text: "blocked" })).ok,
    ).toBe(false);
  });
  it("restores authoritative changes made while the device is disconnected", async () => {
    const instance = await server();
    const one = await device(instance);
    expect((await one.client.api.createConversation({ conversation: chat })).ok).toBe(true);
    one.client.disconnect();
    await instance.backend.api.updateConversation({
      conversationId: chat.id,
      changes: { kind: "wisp", name: "Changed while offline" },
    });
    await one.client.connect();
    expect(one.client.getSnapshot()!.state.chats[chat.id]!.name).toBe("Changed while offline");
  });
});
