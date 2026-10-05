import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { LaunchAtLoginService } from "../../electron/backend/launch-at-login-service.js";
import { UpdateService } from "../../electron/backend/update-service.js";
import { openSshTunnel } from "../../electron/connections/ssh-tunnel.js";
import { createBackend, type Backend } from "../../electron/create-backend.js";
import { InProcessLocalServer } from "../helpers/in-process-local-server.js";
import { adminRequest } from "../../server/admin.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";
import type { ConnectionsView } from "../../shared/connections.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { Chat, ConversationStateView } from "../../shared/conversations.js";

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => Promise<BackendResult<unknown>>;

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const fakeSsh = path.join(__dirname, "../fixtures/fake-ssh.cjs");
const cleanups: Array<() => Promise<void> | void> = [];
const environment = { ...process.env };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.env = { ...environment };
});

const wisp = (id: string, name: string): Chat => ({
  id,
  name,
  label: "",
  description: "",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "",
  timestamp: "2026-10-05T12:00:00.000Z",
  messages: [],
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startServer(): Promise<{ server: WispServer; directory: string }> {
  const directory = await temporaryDirectory("wisp-remote-");
  const server = await createWispServer({
    dataDirectory: directory,
    host: "127.0.0.1",
    port: 0,
    encryption: new MasterKeyEncryption(randomBytes(32)),
    logger: silent,
    agentMode: "fake",
    appVersion: "1.0.0",
    allowModelNetwork: false,
  });
  cleanups.push(() => server.close());
  return { server, directory };
}

/** The desktop backend with fake IPC; reopening the same directory simulates a restart. */
async function desktop(userData?: string, key = randomBytes(32)) {
  const directory = userData ?? (await temporaryDirectory("wisp-desktop-"));
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<[string, unknown]> = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const localServer = new InProcessLocalServer(directory, key);
  const hostActions = {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    selectFiles: vi.fn(async (): Promise<ReadonlyArray<string>> => []),
  };
  const backend: Backend = await createBackend({
    launchAtLoginService: new LaunchAtLoginService({
      platform: "linux",
      packaged: false,
      home: directory,
      execPath: process.execPath,
      env: {},
    }),
    ipcMain: {
      handle: (channel, handler) => void handlers.set(channel, handler as Handler),
      removeHandler: (channel) => void handlers.delete(channel),
    },
    authorizeSender: () => true,
    broadcast: (channel, payload) => void broadcasts.push([channel, payload]),
    openReleasesPage: vi.fn(async () => undefined),
    hostActions,
    localServer,
    // Stands in for the desktop keychain, which keeps its key across restarts.
    encryption: new MasterKeyEncryption(key),
    logger: silent,
    updateService: new UpdateService(updater as never, "0.1.0", false),
    connectionsDirectory: directory,
    deviceName: "Test computer",
    openSshTunnel: (profile, signal) => openSshTunnel(profile, { sshPath: fakeSsh, signal }),
  });
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await backend.dispose();
  };
  cleanups.push(dispose);
  const call = async <T>(channel: string, payload?: unknown): Promise<BackendResult<T>> =>
    (await handlers.get(channel)!({ sender: { id: 1 } } as IpcMainInvokeEvent, payload)) as BackendResult<T>;
  const invoke = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const result = await call<T>(channel, payload);
    if (!result.ok) throw new Error(`${channel}: ${result.error.message}`);
    return result.value;
  };
  const view = () => invoke<ConnectionsView>(WISP_IPC_CHANNELS.getConnections);
  const waitForPhase = (phase: string) =>
    vi.waitFor(
      async () => {
        expect((await view()).status.phase).toBe(phase);
      },
      { timeout: 8_000, interval: 25 },
    );
  const chats = async () =>
    Object.keys((await invoke<ConversationStateView>(WISP_IPC_CHANNELS.getConversationState)).chats).sort();
  return {
    directory,
    key,
    localServer,
    hostActions,
    handlers,
    broadcasts,
    call,
    invoke,
    view,
    waitForPhase,
    chats,
    dispose,
  };
}

describe("desktop connections", () => {
  it("starts its own server on this computer, pairs with it, and lists only the local connection", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    const view = await app.view();
    expect(view).toMatchObject({
      activeId: "local",
      profiles: [{ id: "local", kind: "local", paired: true }],
      status: { profileId: "local", phase: "local" },
    });
    expect(view.status.epoch).toBeGreaterThan(0);
    await app.invoke(WISP_IPC_CHANNELS.initializeConversations, { chats: { local: wisp("local", "Local") } });
    expect(await app.chats()).toEqual(["local"]);
    expect(app.localServer.starts).toBe(1);
    expect(app.localServer.server?.auth.devices()).toEqual([
      expect.objectContaining({ name: "Test computer", local: true }),
    ]);
  });

  it("does what the local server asks on this computer's screen", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    await app.invoke(WISP_IPC_CHANNELS.initializeConversations, { chats: { local: wisp("local", "Local") } });
    await app.invoke(WISP_IPC_CHANNELS.openWorkspaceFolder, { conversationId: "local" });
    expect(app.hostActions.openPath).toHaveBeenCalledWith(expect.stringContaining(app.directory));
    const attachment = path.join(app.directory, "notes.txt");
    await writeFile(attachment, "hello");
    app.hostActions.selectFiles.mockResolvedValueOnce([attachment]);
    await expect(
      app.invoke(WISP_IPC_CHANNELS.attachWorkspaceFiles, { conversationId: "local" }),
    ).resolves.toMatchObject({
      files: [expect.objectContaining({ name: "notes.txt" })],
    });
  });

  it("switches to a server with a pairing code, routes every call there, and comes back", async () => {
    const { server, directory: serverDirectory } = await startServer();
    const app = await desktop();
    await app.waitForPhase("local");
    await app.invoke(WISP_IPC_CHANNELS.initializeConversations, { chats: { local: wisp("local", "Local") } });
    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    expect(remote).toMatchObject({ name: "Home server", paired: false });

    const before = (await app.view()).status.epoch;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id });
    await app.waitForPhase("pairing_required");
    expect(await app.call(WISP_IPC_CHANNELS.getConversationState)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    const { code } = (await adminRequest(serverDirectory, { command: "pair" })) as { code: string };
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await app.waitForPhase("connected");
    expect((await app.view()).status.epoch).toBeGreaterThan(before);
    expect((await app.view()).profiles.find((profile) => profile.id === remote.id)?.paired).toBe(true);

    // The server's conversations, not this computer's.
    expect(await app.chats()).toEqual([]);
    await app.invoke(WISP_IPC_CHANNELS.saveAiSettings, {
      selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" },
      apiKey: "test-key",
    });
    await app.invoke(WISP_IPC_CHANNELS.createConversation, { conversation: wisp("remote", "Remote") });
    await app.invoke(WISP_IPC_CHANNELS.sendMessage, { conversationId: "remote", requestId: "r1", text: "Hi" });
    await vi.waitFor(
      () => {
        expect(
          app.broadcasts.some(
            ([channel, payload]) =>
              channel === WISP_IPC_CHANNELS.agentEvent &&
              (payload as { type: string; conversationId: string }).type === "assistant_message_completed" &&
              (payload as { conversationId: string }).conversationId === "remote",
          ),
        ).toBe(true);
      },
      { timeout: 8_000 },
    );
    expect(await app.chats()).toEqual(["remote"]);
    // Desktop-only operations stay on this computer.
    expect(await app.call(WISP_IPC_CHANNELS.getLaunchAtLoginState)).toMatchObject({ ok: true });
    // Screen actions on a server on another computer are refused, never sent to this app.
    expect(await app.call(WISP_IPC_CHANNELS.openWorkspaceFolder, { conversationId: "remote" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(app.hostActions.openPath).not.toHaveBeenCalled();
    // Wisps on this computer stopped when the server was chosen.
    expect(app.localServer.server).toBeUndefined();

    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    await app.waitForPhase("local");
    expect(await app.chats()).toEqual(["local"]);
    // The server kept its Wisp.
    expect(Object.keys(server.runtime.conversations.getState().chats)).toEqual(["remote"]);
  });

  it("reopens the last connection on restart without starting Wisps on this computer", async () => {
    const { server, directory: serverDirectory } = await startServer();
    const first = await desktop();
    const { profiles } = await first.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    const remote = profiles.find((profile) => profile.kind === "url")!;
    const { code } = (await adminRequest(serverDirectory, { command: "pair" })) as { code: string };
    await first.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await first.waitForPhase("connected");
    await first.dispose();

    const second = await desktop(first.directory, first.key);
    expect((await second.view()).activeId).toBe(remote.id);
    await second.waitForPhase("connected");
    expect(await second.chats()).toEqual([]);
    expect(second.localServer.starts).toBe(0);
  });

  it("connects over SSH, pairing through wispctl on the server", async () => {
    const { server, directory: serverDirectory } = await startServer();
    process.env.FAKE_WISP_DATA_DIR = serverDirectory;
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: server.port,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await app.waitForPhase("connected");
    expect(server.auth.devices()).toEqual([expect.objectContaining({ name: "Test computer" })]);
    expect(await app.chats()).toEqual([]);
  });

  it("explains an SSH failure and goes back to this computer when the connection is removed", async () => {
    process.env.FAKE_SSH_FAIL = "hostkey";
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await app.waitForPhase("error");
    expect((await app.view()).status.message).toMatch(/host key of raspberrypi/);
    await app.invoke(WISP_IPC_CHANNELS.removeConnection, { id: ssh.id });
    await app.waitForPhase("local");
    expect((await app.view()).activeId).toBe("local");
    expect(await app.call(WISP_IPC_CHANNELS.removeConnection, { id: "local" })).toMatchObject({ ok: false });
  });
});
