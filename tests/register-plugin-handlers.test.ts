import { describe, expect, it, vi } from "vitest";
import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import { registerPluginHandlers } from "../electron/ipc/register-plugin-handlers.js";
import type { PluginService } from "../electron/backend/plugin-service.js";

describe("plugin IPC", () => {
  it("rejects untrusted senders on every plugin channel, wraps failures, and removes handlers", async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    const ipc = {
      handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    };
    const getView = vi.fn(async () => ({ secureStorageAvailable: true, plugins: [] }));
    const save = vi.fn(async () => {
      throw new Error("secret-key and provider body");
    });
    const getAccess = vi.fn(() => ({ conversationId: "one", grants: [] }));
    const service = {
      getView,
      save,
      getAccess,
      remove: vi.fn(),
      saveDefaults: vi.fn(),
      testConnection: vi.fn(),
      saveAccess: vi.fn(),
    };
    const registered = registerPluginHandlers(
      ipc as never,
      service as unknown as PluginService,
      (event) => event.sender.id === 10,
    );
    expect(handlers.size).toBe(7);
    for (const handler of handlers.values())
      await expect(handler({ sender: { id: 20 } }, {})).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
    await expect(handlers.get(WISP_IPC_CHANNELS.getPluginSettings)!({ sender: { id: 10 } })).resolves.toEqual({
      ok: true,
      value: { secureStorageAvailable: true, plugins: [] },
    });
    await expect(handlers.get(WISP_IPC_CHANNELS.savePluginSettings)!({ sender: { id: 10 } }, {})).resolves.toEqual({
      ok: false,
      error: { code: "internal_error", message: "The backend could not complete the request.", retryable: true },
    });
    await expect(
      handlers.get(WISP_IPC_CHANNELS.getWispPluginAccess)!({ sender: { id: 10 } }, { conversationId: "one" }),
    ).resolves.toMatchObject({ ok: true, value: { conversationId: "one" } });
    expect(getAccess).toHaveBeenCalledWith({ conversationId: "one" });
    registered.dispose();
    expect(handlers.size).toBe(0);
  });
});
