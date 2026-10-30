import { describe, expect, it, vi } from "vitest";

import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import { registerRuntimeEventHandlers } from "../backend/handlers/register-runtime-event-handlers.js";
import { RuntimeEventLog } from "../backend/runtime-event-log.js";

function createIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  return { ipcMain, handlers };
}

const INVALID = {
  ok: false,
  error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
};

describe("registerRuntimeEventHandlers", () => {
  it("records a running conversation's events and reads them after a sequence", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = new RuntimeEventLog();
    const registration = registerRuntimeEventHandlers(
      ipcMain as never,
      log,
      (id) => id === "wisp-1",
      () => true,
    );
    const setRecording = handlers.get(WISP_IPC_CHANNELS.setRuntimeEventRecording);
    const getEvents = handlers.get(WISP_IPC_CHANNELS.getRuntimeEvents);

    await expect(setRecording?.({}, { conversationId: "wisp-1", recording: true })).resolves.toMatchObject({
      ok: true,
      value: { conversationId: "wisp-1", recording: true, events: [] },
    });
    log.record("wisp-1", "pi", { type: "agent_start" });
    log.record("wisp-1", "pi", { type: "agent_settled" });

    const all = (await getEvents?.({}, { conversationId: "wisp-1" })) as { value: { events: Array<{ type: string }> } };
    expect(all.value.events.map(({ type }) => type)).toEqual(["agent_start", "agent_settled"]);
    await expect(getEvents?.({}, { conversationId: "wisp-1", after: 1 })).resolves.toMatchObject({
      ok: true,
      value: { events: [{ sequence: 2, type: "agent_settled" }] },
    });

    await setRecording?.({}, { conversationId: "wisp-1", recording: false });
    expect(log.isRecording("wisp-1")).toBe(false);

    registration.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(WISP_IPC_CHANNELS.getRuntimeEvents);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(WISP_IPC_CHANNELS.setRuntimeEventRecording);
  });

  it("refuses a conversation that is not running and forgets its events", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = new RuntimeEventLog();
    log.setRecording("gone", true);
    const registration = registerRuntimeEventHandlers(
      ipcMain as never,
      log,
      () => false,
      () => true,
    );

    await expect(handlers.get(WISP_IPC_CHANNELS.getRuntimeEvents)?.({}, { conversationId: "gone" })).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "The conversation was not found.", retryable: false },
    });
    expect(log.isRecording("gone")).toBe(false);
    await expect(
      handlers.get(WISP_IPC_CHANNELS.setRuntimeEventRecording)?.({}, { conversationId: "gone", recording: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(log.isRecording("gone")).toBe(false);

    registration.dispose();
  });

  it("rejects untrusted senders and invalid payloads", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = new RuntimeEventLog();
    const isRunning = vi.fn(() => true);
    const untrusted = registerRuntimeEventHandlers(ipcMain as never, log, isRunning, () => false);
    await expect(
      handlers.get(WISP_IPC_CHANNELS.setRuntimeEventRecording)?.({}, { conversationId: "wisp-1", recording: true }),
    ).resolves.toEqual(INVALID);
    expect(log.isRecording("wisp-1")).toBe(false);
    untrusted.dispose();

    const trusted = registerRuntimeEventHandlers(ipcMain as never, log, isRunning, () => true);
    for (const payload of [
      null,
      {},
      { conversationId: "../x" },
      { conversationId: "wisp-1", after: -1 },
      { conversationId: "wisp-1", after: 1.5 },
      { conversationId: "wisp-1", after: "2" },
    ]) {
      await expect(handlers.get(WISP_IPC_CHANNELS.getRuntimeEvents)?.({}, payload)).resolves.toEqual(INVALID);
    }
    for (const payload of [{ conversationId: "wisp-1" }, { conversationId: "wisp-1", recording: "yes" }]) {
      await expect(handlers.get(WISP_IPC_CHANNELS.setRuntimeEventRecording)?.({}, payload)).resolves.toEqual(INVALID);
    }
    expect(isRunning).not.toHaveBeenCalled();
    trusted.dispose();
  });
});
