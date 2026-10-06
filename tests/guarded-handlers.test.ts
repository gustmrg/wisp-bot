import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import { registerGuardedHandlers } from "../electron/ipc/guarded-handlers.js";

type Handler = (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: Handler) => void handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => void handlers.delete(channel)),
  };
}

const event = {} as IpcMainInvokeEvent;

describe("registerGuardedHandlers", () => {
  it("never runs a handler for an untrusted sender", async () => {
    const ipcMain = fakeIpcMain();
    const handler = vi.fn(() => "secret");
    registerGuardedHandlers(ipcMain, () => false, [["channel", handler]]);

    await expect(ipcMain.handlers.get("channel")!(event, {})).resolves.toEqual({
      ok: false,
      error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("wraps values and sanitizes both backend and unexpected errors", async () => {
    const ipcMain = fakeIpcMain();
    registerGuardedHandlers(ipcMain, () => true, [
      ["value", (payload, source) => ({ payload, sameEvent: source === event })],
      [
        "known",
        () => {
          throw new WispBackendError("not_found", "Missing.");
        },
      ],
      ["unexpected", async () => Promise.reject(new Error("/home/user/secret path"))],
    ]);

    await expect(ipcMain.handlers.get("value")!(event, 1)).resolves.toEqual({
      ok: true,
      value: { payload: 1, sameEvent: true },
    });
    await expect(ipcMain.handlers.get("known")!(event, undefined)).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "Missing.", retryable: false },
    });
    await expect(ipcMain.handlers.get("unexpected")!(event, undefined)).resolves.toEqual({
      ok: false,
      error: { code: "internal_error", message: "The backend could not complete the request.", retryable: true },
    });
  });

  it("removes every channel on dispose", () => {
    const ipcMain = fakeIpcMain();
    const registration = registerGuardedHandlers(ipcMain, () => true, [
      ["one", () => 1],
      ["two", () => 2],
    ]);

    registration.dispose();

    expect(ipcMain.handlers.size).toBe(0);
  });
});
