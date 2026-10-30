import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

const directories: string[] = [];

async function createLog() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-runtime-event-handlers-"));
  directories.push(directory);
  return new RuntimeEventLog({ directory });
}

const notReceived = vi.fn(async () => {
  throw new Error("not called");
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const INVALID = {
  ok: false,
  error: { code: "invalid_request", message: "The backend request is invalid.", retryable: false },
};

describe("registerRuntimeEventHandlers", () => {
  it("records a running conversation's events and reads them after a sequence", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = await createLog();
    const registration = registerRuntimeEventHandlers(
      ipcMain as never,
      log,
      { isRunning: (id) => id === "wisp-1", receive: notReceived },
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

  it("refuses a conversation that is not running", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = await createLog();
    const registration = registerRuntimeEventHandlers(
      ipcMain as never,
      log,
      { isRunning: () => false, receive: notReceived },
      () => true,
    );

    await expect(handlers.get(WISP_IPC_CHANNELS.getRuntimeEvents)?.({}, { conversationId: "gone" })).resolves.toEqual({
      ok: false,
      error: { code: "not_found", message: "The conversation was not found.", retryable: false },
    });
    await expect(
      handlers.get(WISP_IPC_CHANNELS.setRuntimeEventRecording)?.({}, { conversationId: "gone", recording: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(log.isRecording("gone")).toBe(false);

    registration.dispose();
  });

  it("rejects untrusted senders and invalid payloads", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = await createLog();
    const isRunning = vi.fn(() => true);
    const untrusted = registerRuntimeEventHandlers(
      ipcMain as never,
      log,
      { isRunning, receive: notReceived },
      () => false,
    );
    await expect(
      handlers.get(WISP_IPC_CHANNELS.setRuntimeEventRecording)?.({}, { conversationId: "wisp-1", recording: true }),
    ).resolves.toEqual(INVALID);
    expect(log.isRecording("wisp-1")).toBe(false);
    untrusted.dispose();

    const trusted = registerRuntimeEventHandlers(
      ipcMain as never,
      log,
      { isRunning, receive: notReceived },
      () => true,
    );
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
    for (const channel of [WISP_IPC_CHANNELS.clearRuntimeEvents, WISP_IPC_CHANNELS.saveRuntimeEventsToWorkspace]) {
      await expect(handlers.get(channel)?.({}, { conversationId: "../x" })).resolves.toEqual(INVALID);
    }
    expect(isRunning).not.toHaveBeenCalled();
    trusted.dispose();
  });

  it("saves the recorded events to the workspace inbox and clears them", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const log = await createLog();
    const received: Array<{ name: string; size: number; text: string }> = [];
    const receive = vi.fn(
      async (_conversationId: string, file: { name: string; size: number }, content: AsyncIterable<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of content) chunks.push(chunk);
        received.push({ ...file, text: Buffer.concat(chunks).toString("utf8") });
        return { name: file.name, path: `inbox/${file.name}`, size: file.size };
      },
    );
    registerRuntimeEventHandlers(ipcMain as never, log, { isRunning: () => true, receive }, () => true);
    const save = handlers.get(WISP_IPC_CHANNELS.saveRuntimeEventsToWorkspace);

    await expect(save?.({}, { conversationId: "wisp-1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "There are no runtime events to save." },
    });

    await log.setRecording("wisp-1", true);
    log.record("wisp-1", "pi", { type: "agent_start" });
    const saved = (await save?.({}, { conversationId: "wisp-1" })) as {
      ok: true;
      value: { path: string; size: number };
    };
    expect(saved).toMatchObject({ ok: true, value: { path: "inbox/runtime-events.jsonl" } });
    expect(receive).toHaveBeenCalledWith(
      "wisp-1",
      expect.objectContaining({ name: "runtime-events.jsonl" }),
      expect.anything(),
    );
    expect(received[0]?.size).toBe(saved.value.size);
    expect(JSON.parse(received[0]?.text ?? "")).toMatchObject({ sequence: 1, type: "agent_start" });

    await expect(
      handlers.get(WISP_IPC_CHANNELS.clearRuntimeEvents)?.({}, { conversationId: "wisp-1" }),
    ).resolves.toMatchObject({ ok: true, value: { recording: true, events: [] } });
    await expect(save?.({}, { conversationId: "wisp-1" })).resolves.toMatchObject({ ok: false });
  });
});
