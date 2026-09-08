import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { BackendProvider } from "@/features/backend/backend-provider";
import { clearInstanceDrafts, loadPendingAdmissions, savePendingAdmission } from "@/features/drafts/draft-storage";
import { RemoteBackendClient } from "../../client/remote-backend-client";
import type { RemoteServerDescriptor, RemoteSnapshot } from "../../shared/remote-protocol";
import { useConversations } from "./use-conversations";

it("reuses an uncertain admission ID for Retry and the unchanged composer draft after lost ACK and status reads", async () => {
  const descriptor: RemoteServerDescriptor = {
    protocolVersion: 1,
    serverId: "server",
    bootId: "boot",
    version: "1.0.0",
    owner: { id: "owner", name: "Owner" },
    capabilities: [],
    limits: { maxPendingPerConversation: 8, maxRunning: 4, maxMessageBytes: 131072 },
  };
  const snapshot: RemoteSnapshot = {
    serverId: "server",
    bootId: "boot",
    cursor: "generation:1",
    revision: 1,
    revisions: { atlas: 1 },
    settingsRevision: 1,
    state: {
      initialized: true,
      recoveredCorruptState: false,
      agentEventSequence: 1,
      pendingToolApprovals: [],
      statuses: { atlas: "idle" },
      chats: {
        atlas: {
          id: "atlas",
          kind: "wisp",
          name: "Atlas",
          label: "",
          description: "",
          shape: "circle",
          notifyOnUpdatesEnabled: true,
          timestamp: "Now",
          preview: "",
          messages: [],
        },
      },
    },
  };
  const success = (value: unknown) => Response.json({ ok: true, value });
  const commands: Array<{ requestId: string; text: string }> = [];
  const executed = new Set<string>();
  let acknowledgementAvailable = false;
  let statusReads = 0;
  const client = new RemoteBackendClient({
    baseUrl: "https://wisp.tailnet.ts.net",
    auth: {
      kind: "bearer",
      credentials: {
        serverId: "server",
        deviceId: "device",
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      },
    },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/server")) return success(descriptor);
      if (path.endsWith("/snapshot")) return success(snapshot);
      if (path.endsWith("/events"))
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      if (path.includes("/requests/")) {
        statusReads++;
        throw new TypeError("The status response was also lost");
      }
      if (path.endsWith("/messages")) {
        const command = JSON.parse(String(init?.body)) as { requestId: string; text: string };
        commands.push(command);
        executed.add(command.requestId);
        if (!acknowledgementAvailable) throw new TypeError("The ACK was lost after executing the command");
        snapshot.state.chats.atlas!.messages = [
          { id: command.requestId, type: "outgoing", text: command.text, status: "complete" },
          {
            id: `${command.requestId}:assistant`,
            type: "incoming",
            text: "A terminal tool error",
            status: "failed",
            retryable: true,
          },
        ];
        return success({ requestId: command.requestId, status: "failed", revision: 2 });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  await client.connect();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider value={{ api: client.api, instanceId: "server", remote: true, writable: true }}>
      {children}
    </BackendProvider>
  );
  let hook = renderHook(useConversations, { wrapper });
  try {
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => expect(await hook.result.current.sendMessage("atlas", "Run the tool")).toBe(false));
    const requestId = commands[0]!.requestId;
    await act(async () => expect(await hook.result.current.retryMessage("atlas", requestId)).toBe(false));
    expect(statusReads).toBe(2);
    // Reload the renderer while admission remains unknown; only device draft storage survives.
    expect(loadPendingAdmissions("server").has(requestId)).toBe(true);
    hook.unmount();
    hook = renderHook(useConversations, { wrapper });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    acknowledgementAvailable = true;
    await act(async () => expect(await hook.result.current.sendMessage("atlas", "Run the tool")).toBe(true));
    expect(commands).toHaveLength(3);
    expect(new Set(commands.map(({ requestId }) => requestId)).size).toBe(1);
    expect(executed.size).toBe(1);
    expect(loadPendingAdmissions("server").size).toBe(0);
    // A confirmed terminal request cannot be rerun through the recovery action.
    await act(async () => expect(await hook.result.current.retryMessage("atlas", requestId)).toBe(false));
    expect(commands).toHaveLength(3);
    expect(hook.result.current.error).toContain("Send a new message to run it again");
  } finally {
    hook.unmount();
    client.disconnect();
  }
});

it("scopes pending request identities to one instance and removes them with its drafts", () => {
  savePendingAdmission("server-one", "request-one", { conversationId: "atlas", text: "One" });
  savePendingAdmission("server-two", "request-two", { conversationId: "atlas", text: "Two" });
  expect(loadPendingAdmissions("server-one").has("request-two")).toBe(false);
  clearInstanceDrafts("server-one");
  expect(loadPendingAdmissions("server-one").size).toBe(0);
  expect(loadPendingAdmissions("server-two").has("request-two")).toBe(true);
});

it("does not issue a remote command if its request identity cannot be stored", async () => {
  const sendMessage = vi.fn();
  const api = {
    getConversationState: async () => ({
      ok: true,
      value: {
        initialized: true,
        recoveredCorruptState: false,
        agentEventSequence: 0,
        pendingToolApprovals: [],
        statuses: { atlas: "idle" },
        chats: { atlas: { id: "atlas", kind: "wisp", messages: [] } },
      },
    }),
    subscribeToAgentEvents: () => () => undefined,
    sendMessage,
  } as unknown as import("../../shared/backend-api").BackendApi;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendProvider value={{ api, instanceId: "server", remote: true, writable: true }}>{children}</BackendProvider>
  );
  const hook = renderHook(useConversations, { wrapper });
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage disabled", "SecurityError");
  });
  try {
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => expect(await hook.result.current.sendMessage("atlas", "Run a tool")).toBe(false));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain("Enable device storage before sending");
  } finally {
    storage.mockRestore();
    hook.unmount();
  }
});
