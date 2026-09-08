import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../electron/connections/connection-manager.js";
import { ConnectionProfileStore } from "../electron/connections/profile-store.js";
import { OpenSshTransport } from "../electron/connections/ssh-tunnel.js";
import { registerBackendHandlers } from "../electron/ipc/register-backend-handlers.js";
import type { BackendApi } from "../shared/backend-api.js";
import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import { consumeEventStream } from "../client/event-stream.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.useRealTimers();
});
describe("connection lifecycle boundaries", () => {
  it("preserves and validates the policy editor revision across IPC", async () => {
    const api = { saveToolPolicy: vi.fn(async () => ({ ok: true, value: {} })) } as unknown as BackendApi;
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() };
    const registered = registerBackendHandlers(
      ipc,
      () => api,
      () => true,
    );
    const handler = ipc.handle.mock.calls.find(([channel]) => channel === WISP_IPC_CHANNELS.saveToolPolicy)![1];
    const settings = { autoReview: false, rules: [] };
    await handler({}, { ...settings, expectedRevision: 4 });
    expect(api.saveToolPolicy).toHaveBeenCalledExactlyOnceWith(settings, 4);
    expect(await handler({}, { ...settings, expectedRevision: "latest" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(api.saveToolPolicy).toHaveBeenCalledTimes(1);
    registered.dispose();
  });
  it("unregisters IPC handlers without disposing any backend agents", () => {
    const api = { disposeConversation: vi.fn() } as unknown as BackendApi;
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() };
    const handlers = registerBackendHandlers(
      ipc,
      () => api,
      () => true,
    );
    handlers.dispose();
    expect(ipc.removeHandler).toHaveBeenCalledTimes(ipc.handle.mock.calls.length);
    expect(api.disposeConversation).not.toHaveBeenCalled();
  });
  it("validates inputs and drops late responses after changing backend", async () => {
    const calls = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>();
    const ipc = {
      handle: (channel: string, listener: unknown) =>
        calls.set(channel, listener as (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>),
      removeHandler: vi.fn(),
    } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
    let resolve: ((value: { ok: true; value: Record<string, never> }) => void) | undefined;
    const first = {
      sendMessage: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    } as unknown as BackendApi;
    let current = first;
    registerBackendHandlers(
      ipc,
      () => current,
      () => true,
    );
    const handler = calls.get(WISP_IPC_CHANNELS.sendMessage)!;
    expect(
      await handler({} as IpcMainInvokeEvent, { conversationId: "../../evil", requestId: "request", text: "hello" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(first.sendMessage).not.toHaveBeenCalled();
    const pending = handler({} as IpcMainInvokeEvent, { conversationId: "chat", requestId: "request", text: "hello" });
    current = {} as BackendApi;
    resolve!({ ok: true, value: {} });
    expect(await pending).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
  });
  it("switches profiles and shuts down transports without stopping local runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-lifecycle-"));
    directories.push(directory);
    const profiles = new ConnectionProfileStore(directory, {
      isAvailable: () => false,
      encrypt: () => {
        throw new Error();
      },
      decrypt: () => {
        throw new Error();
      },
    });
    await profiles.load();
    await profiles.save({ kind: "https", id: "remote", name: "Remote", endpoint: "https://wisp.tailnet.ts.net" });
    const local = { disposeConversation: vi.fn() } as unknown as BackendApi;
    const manager = new ConnectionManager(local, profiles, new OpenSshTransport(directory), vi.fn());
    expect(manager.getBackend()).toBe(local);
    expect((await manager.connect({ id: "remote" })).phase).toBe("pairing_required");
    const remoteGeneration = manager.getState().generation;
    expect((await manager.connect({ id: "local" })).phase).toBe("local");
    expect(manager.getState().generation).toBeGreaterThan(remoteGeneration);
    manager.dispose();
    expect(local.disposeConversation).not.toHaveBeenCalled();
  });
  it("terminates an event stream when heartbeats stop", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = consumeEventStream(response, vi.fn(), new AbortController().signal, 1000);
    const rejection = expect(result).rejects.toThrow("heartbeat");
    await vi.advanceTimersByTimeAsync(1001);
    await rejection;
  });
});
