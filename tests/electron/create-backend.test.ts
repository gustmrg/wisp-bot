import { LaunchAtLoginService } from "../../electron/backend/launch-at-login-service.js";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EncryptionService } from "../../electron/backend/encrypted-credential-store.js";
import { StructuredLogger } from "../../electron/backend/structured-logger.js";
import { UpdateService } from "../../electron/backend/update-service.js";
import { createBackend, disposeWithin, refreshModelCatalog, type Backend } from "../../electron/create-backend.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { Chat, ConversationStateView } from "../../shared/conversations.js";

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => Promise<BackendResult<unknown>>;

// Channels the main process pushes to the renderer rather than handling.
const PUSH_CHANNELS = new Set<string>([
  WISP_IPC_CHANNELS.agentEvent,
  WISP_IPC_CHANNELS.mcpSettingsChanged,
  WISP_IPC_CHANNELS.updateState,
  WISP_IPC_CHANNELS.conversationChanged,
]);

const encryption: EncryptionService = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8"),
  decrypt: (value) => value.toString("utf8"),
};

const atlas: Chat = {
  id: "atlas",
  name: "Atlas",
  label: "Research",
  description: "",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "2026-09-29T12:00:00.000Z",
  messages: [],
};

const directories: string[] = [];
const backends: Backend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function compose() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "wisp-backend-"));
  directories.push(dataDirectory);
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<[string, unknown]> = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const backend = await createBackend({
    dataDirectory,
    launchAtLoginService: new LaunchAtLoginService({
      platform: "linux",
      packaged: false,
      home: dataDirectory,
      execPath: process.execPath,
      env: {},
    }),
    ipcMain: {
      handle: (channel, handler) => void handlers.set(channel, handler as Handler),
      removeHandler: (channel) => void handlers.delete(channel),
    },
    authorizeSender: () => true,
    broadcast: (channel, payload) => void broadcasts.push([channel, payload]),
    selectApprovalWindowId: () => 1,
    openExternal: vi.fn(async () => undefined),
    openReleasesPage: vi.fn(async () => undefined),
    encryption,
    logger: new StructuredLogger({ info: () => undefined, warn: () => undefined }),
    agentMode: "fake",
    appVersion: "0.0.0-test",
    updateService: new UpdateService(updater as never, "0.1.0", false),
    allowModelNetwork: false,
  });
  backends.push(backend);
  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const result = await handlers.get(channel)!({} as IpcMainInvokeEvent, payload);
    if (!result.ok) throw new Error(`${channel}: ${result.error.message}`);
    return result.value as T;
  };
  return { backend, handlers, broadcasts, invoke };
}

describe("createBackend", () => {
  it("handles every renderer request channel and removes them all on dispose", async () => {
    const { backend, handlers } = await compose();
    const requestChannels = Object.values(WISP_IPC_CHANNELS).filter((channel) => !PUSH_CHANNELS.has(channel));

    expect([...handlers.keys()].sort()).toEqual(requestChannels.sort());

    await backend.dispose();
    backends.splice(backends.indexOf(backend), 1);
    expect(handlers.size).toBe(0);
  });

  it("runs a Wisp turn through the registered handlers and pushes the stored reply", async () => {
    const { broadcasts, invoke } = await compose();
    await invoke(WISP_IPC_CHANNELS.saveAiSettings, {
      selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" },
      apiKey: "test-key",
    });
    await invoke(WISP_IPC_CHANNELS.initializeConversations, { chats: { atlas } });
    // Single-chat changes answer with what changed, not every conversation or transcript.
    await expect(
      invoke(WISP_IPC_CHANNELS.appendConversationMessage, {
        conversationId: "atlas",
        message: { id: "request-1", type: "outgoing", text: "Hello", status: "queued" },
      }),
    ).resolves.toMatchObject({
      chat: { id: "atlas", preview: "Hello" },
      added: [expect.objectContaining({ id: "request-1" })],
      updated: [],
    });

    await invoke(WISP_IPC_CHANNELS.sendMessage, { conversationId: "atlas", requestId: "request-1", text: "Hello" });

    await vi.waitFor(
      () => {
        const pushed = broadcasts.filter(([channel]) => channel === WISP_IPC_CHANNELS.conversationChanged);
        expect(pushed.at(-1)?.[1]).toMatchObject({
          chat: { id: "atlas" },
          added: [expect.objectContaining({ id: "request-1:assistant", type: "incoming", status: "complete" })],
        });
      },
      { timeout: 3_000 },
    );
    expect(broadcasts.some(([channel]) => channel === WISP_IPC_CHANNELS.agentEvent)).toBe(true);
    const state = await invoke<ConversationStateView>(WISP_IPC_CHANNELS.getConversationState);
    expect(state.chats.atlas?.messages).toHaveLength(2);

    // Transcript pages and search answer through the same guarded handlers.
    await expect(
      invoke(WISP_IPC_CHANNELS.getConversationMessages, { conversationId: "atlas", page: "latest" }),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "request-1" }), expect.objectContaining({ id: "request-1:assistant" })],
      olderCursor: null,
      newerCursor: null,
    });
    // Newest first: the fake reply echoes the prompt, so it matches too.
    await expect(invoke(WISP_IPC_CHANNELS.searchMessages, { query: "hel" })).resolves.toEqual([
      expect.objectContaining({ messageId: "request-1:assistant", snippet: "Fake response to: Hello" }),
      expect.objectContaining({ conversationId: "atlas", messageId: "request-1", snippet: "Hello" }),
    ]);
    await expect(invoke(WISP_IPC_CHANNELS.searchMessages, { query: "he" })).rejects.toThrow("at least 3 characters");
  });
});

describe("disposeWithin", () => {
  it("reports a disposal that finishes in time", async () => {
    await expect(disposeWithin(async () => undefined, 1_000)).resolves.toBe(true);
    await expect(disposeWithin(() => Promise.reject(new Error("failed")), 1_000)).resolves.toBe(true);
  });

  it("gives up on a disposal that never settles so the app can still quit", async () => {
    vi.useFakeTimers();
    try {
      const outcome = disposeWithin(() => new Promise<void>(() => undefined), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(outcome).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refreshModelCatalog", () => {
  const selection = { providerId: "openrouter", modelId: "openai/gpt-oss-120b" };

  it("re-applies the model when the fresh catalog makes the saved one usable", async () => {
    const getSelection = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(selection);
    const applyModel = vi.fn(async () => undefined);

    await refreshModelCatalog({ getSelection, refreshCatalog: async () => undefined }, applyModel, { warn: vi.fn() });

    expect(applyModel).toHaveBeenCalledWith(selection);
  });

  it("leaves Wisps alone when the saved model did not change", async () => {
    const applyModel = vi.fn(async () => undefined);

    await refreshModelCatalog(
      { getSelection: async () => ({ ...selection }), refreshCatalog: async () => undefined },
      applyModel,
      { warn: vi.fn() },
    );

    expect(applyModel).not.toHaveBeenCalled();
  });

  it("logs a failed refresh instead of throwing", async () => {
    const warn = vi.fn();

    await refreshModelCatalog(
      { getSelection: async () => null, refreshCatalog: () => Promise.reject(new Error("offline")) },
      vi.fn(),
      { warn },
    );

    expect(warn).toHaveBeenCalledWith("model_catalog_refresh_failed", { code: "internal_error" });
  });
});
