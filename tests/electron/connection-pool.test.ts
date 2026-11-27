import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import type { RemoteTransport } from "../../client/remote-session.js";
import { LaunchAtLoginService } from "../../electron/backend/launch-at-login-service.js";
import { UpdateService } from "../../electron/backend/update-service.js";
import type { SshInteraction } from "../../electron/connections/ssh-auth.js";
import { createBackend, type Backend } from "../../electron/create-backend.js";
import { Tailscale } from "../../electron/local-server/tailscale.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";
import type { ConnectionEventMessage, ConnectionsView, SshConnectionProfile } from "../../shared/connections.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { ConversationStateView, Wisp } from "../../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";
import { FakeTailscale } from "../helpers/fake-tailscale.js";
import { InProcessLocalServer } from "../helpers/in-process-local-server.js";
import { environmentRestorer } from "../helpers/restore-environment.js";

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => Promise<BackendResult<unknown>>;

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const cleanups: Array<() => Promise<void> | void> = [];
const restoreEnvironment = environmentRestorer();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  restoreEnvironment();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startServer(appVersion = "1.0.0"): Promise<{ server: WispServer; directory: string }> {
  const directory = await temporaryDirectory("wisp-pool-remote-");
  const server = await createWispServer({
    dataDirectory: directory,
    host: "127.0.0.1",
    port: 0,
    encryption: new MasterKeyEncryption(randomBytes(32)),
    logger: silent,
    agentMode: "fake",
    appVersion,
    allowModelNetwork: false,
    adminSocket: false,
    requirePrivateDirectory: false,
  });
  cleanups.push(() => server.close());
  return { server, directory };
}

async function pairCode(server: WispServer): Promise<string> {
  return ((await server.admin({ command: "pair" })) as { code: string }).code;
}

async function desktop(
  userData?: string,
  key = randomBytes(32),
  options: {
    choose?: boolean;
    fakeAskpass?: boolean;
    openSshTunnel?: (
      profile: SshConnectionProfile,
      signal: AbortSignal,
      interaction: SshInteraction | undefined,
      onServerPort: (port: number) => Promise<void>,
    ) => Promise<RemoteTransport>;
    watchWake?: (onWake: () => void) => () => void;
  } = {},
) {
  const directory = userData ?? (await temporaryDirectory("wisp-pool-desktop-"));
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<[string, unknown]> = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const localServer = new InProcessLocalServer(directory, key);
  const tailscale = new FakeTailscale();
  let wakeCallback: (() => void) | undefined;
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
    hostActions: {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => undefined),
      selectFiles: vi.fn(async () => []),
    },
    localServer,
    encryption: new MasterKeyEncryption(key),
    logger: silent,
    updateService: new UpdateService(updater as never, "0.1.0", false),
    connectionsDirectory: directory,
    deviceName: "Test computer",
    appVersion: "1.0.0",
    fetch: tailscale.fetch,
    tailscale: new Tailscale({ locate: tailscale.locate, run: tailscale.run }),
    watchWake:
      options.watchWake ??
      ((onWake) => {
        wakeCallback = onWake;
        return () => {
          wakeCallback = undefined;
        };
      }),
    ...(options.fakeAskpass
      ? {
          startSshAskpass: async () =>
            ({
              register: () => ({ env: {}, dispose: () => undefined }),
              close: async () => undefined,
            }) as never,
        }
      : {}),
    ...(options.openSshTunnel ? { openSshTunnel: options.openSshTunnel } : {}),
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
  if ((options.choose ?? true) && (await view()).status.phase === "choosing") {
    await invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
  }
  return {
    directory,
    key,
    localServer,
    broadcasts,
    call,
    invoke,
    view,
    triggerWake: () => wakeCallback?.(),
    dispose,
  };
}

const makeWisp = (id: string, name: string): Wisp => ({
  id,
  name,
  role: "",
  soul: "",
  appearance: DEFAULT_WISP_APPEARANCE,
});

describe("multi-environment session pool", () => {
  it("keeps the local server running in the background and switches instantly", async () => {
    const { server } = await startServer();
    const app = await desktop();
    await vi.waitFor(async () => expect((await app.view()).status.phase).toBe("local"), { timeout: 8_000 });

    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    const code = await pairCode(server);
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await vi.waitFor(async () => expect((await app.view()).status.phase).toBe("connected"), { timeout: 8_000 });

    // Local server remained running in the background and both environments report their phase.
    expect(app.localServer.server).toBeDefined();
    expect(app.localServer.starts).toBe(1);
    await vi.waitFor(async () => {
      const env = (await app.view()).environments;
      expect(env?.local?.phase).toBe("local");
      expect(env?.[remote.id]?.phase).toBe("connected");
    });

    // Switching back to local is instantaneous without restarting localServer; remote stays connected in the pool.
    const epochBefore = (await app.view()).status.epoch;
    const switchedToLocal = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    expect(switchedToLocal.status.phase).toBe("local");
    expect(switchedToLocal.status.epoch).toBe(epochBefore + 1);
    expect(app.localServer.starts).toBe(1);
    expect(switchedToLocal.environments?.[remote.id]?.phase).toBe("connected");

    // Switching back to remote is also instantaneous because its pooled session stayed connected.
    const switchedToRemote = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.activateConnection, { id: remote.id });
    expect(switchedToRemote.status.phase).toBe("connected");
    expect(switchedToRemote.status.epoch).toBe(epochBefore + 2);
    // This computer's Wisps keep running while a server is in use.
    expect(app.localServer.server).toBeDefined();
    expect(switchedToRemote.environments?.local?.phase).toBe("local");
    expect(app.localServer.starts).toBe(1);
  });

  it("dispatches allowlisted runtime operations to any connected environment and forwards scoped events", async () => {
    const { server } = await startServer();
    const app = await desktop();
    await vi.waitFor(async () => expect((await app.view()).status.phase).toBe("local"), { timeout: 8_000 });
    await app.invoke(WISP_IPC_CHANNELS.initializeConversations);
    await app.invoke(WISP_IPC_CHANNELS.createWisp, {
      wisp: makeWisp("local-wisp", "Local"),
      notifyOnUpdatesEnabled: true,
    });

    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Work server",
      url: server.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    const code = await pairCode(server);
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await vi.waitFor(async () => expect((await app.view()).status.phase).toBe("connected"), { timeout: 8_000 });

    // Switch back to local while remote remains connected in the background.
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    expect((await app.view()).activeId).toBe("local");

    // Dispatch runtime operations directly to the background remote environment.
    await app.invoke(WISP_IPC_CHANNELS.invokeConnectionOperation, {
      connectionId: remote.id,
      operation: "saveAiSettings",
      payload: { selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" }, apiKey: "remote-key" },
    });
    const created = await app.invoke<ConversationStateView>(WISP_IPC_CHANNELS.invokeConnectionOperation, {
      connectionId: remote.id,
      operation: "createWisp",
      payload: { wisp: makeWisp("remote-wisp", "Remote"), notifyOnUpdatesEnabled: true },
    });
    expect(Object.keys(created.wisps)).toEqual(["remote-wisp"]);

    // Local environment stayed completely isolated (still has only local-wisp).
    const localState = await app.invoke<ConversationStateView>(WISP_IPC_CHANNELS.getConversationState);
    expect(Object.keys(localState.wisps)).toEqual(["local-wisp"]);

    // Send a message on the background remote environment and observe scoped connectionEvent updates
    // WITHOUT leaking onto the active workspace's agentEvent channel.
    const broadcastsBefore = app.broadcasts.length;
    await app.invoke(WISP_IPC_CHANNELS.invokeConnectionOperation, {
      connectionId: remote.id,
      operation: "sendMessage",
      payload: { conversationId: "remote-wisp", requestId: "bg-r1", text: "Hello background" },
    });

    await vi.waitFor(
      () => {
        const scoped = app.broadcasts
          .slice(broadcastsBefore)
          .filter(([channel]) => channel === WISP_IPC_CHANNELS.connectionEvent)
          .map(([, payload]) => payload as ConnectionEventMessage);
        expect(
          scoped.some(
            (event) =>
              event.connectionId === remote.id &&
              event.type === "agentEvent" &&
              (event.payload as { type?: string }).type === "assistant_message_completed",
          ),
        ).toBe(true);
      },
      { timeout: 8_000 },
    );

    // Active agentEvent channel did NOT receive the background remote server's events.
    const leakedActiveAgentEvents = app.broadcasts
      .slice(broadcastsBefore)
      .filter(
        ([channel, payload]) =>
          channel === WISP_IPC_CHANNELS.agentEvent &&
          (payload as { conversationId?: string }).conversationId === "remote-wisp",
      );
    expect(leakedActiveAgentEvents).toEqual([]);

    // Security allowlist: desktop-only operations and arbitrary strings are rejected.
    for (const forbidden of [
      "saveConnection",
      "removeConnection",
      "setLaunchAtLogin",
      "checkForUpdates",
      "__proto__",
    ]) {
      expect(
        await app.call(WISP_IPC_CHANNELS.invokeConnectionOperation, {
          connectionId: remote.id,
          operation: forbidden,
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }

    // Unknown or disconnected environments return clean structured errors.
    expect(
      await app.call(WISP_IPC_CHANNELS.invokeConnectionOperation, {
        connectionId: "missing",
        operation: "getAiSettings",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });

    // A saved server that was never paired has no session to run it on.
    const unpaired = (
      await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
        kind: "url",
        name: "Unpaired server",
        url: "https://test-host.invalid",
      })
    ).profiles.find((profile) => profile.name === "Unpaired server")!;
    expect(
      await app.call(WISP_IPC_CHANNELS.invokeConnectionOperation, {
        connectionId: unpaired.id,
        operation: "getAiSettings",
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
  });

  it("quietly reconnects paired background SSH profiles on restart without SSH prompts or auto-pairing", async () => {
    const { server } = await startServer();
    const sshCalls: Array<{ host: string; interactive: boolean }> = [];
    const autoPairCalls: string[] = [];

    const openFakeTunnel = async (
      profile: SshConnectionProfile,
      _signal: AbortSignal,
      interaction: SshInteraction | undefined,
    ): Promise<RemoteTransport> => {
      sshCalls.push({ host: profile.host, interactive: Boolean(interaction) });
      return {
        baseUrl: server.url,
        closed: new Promise(() => undefined),
        close: () => undefined,
        requestPairingCode: async () => {
          autoPairCalls.push(profile.host);
          return pairCode(server);
        },
      };
    };

    // First run: pair SSH server interactively while active, then switch back to local.
    const first = await desktop(undefined, undefined, { fakeAskpass: true, openSshTunnel: openFakeTunnel });
    await vi.waitFor(async () => expect((await first.view()).status.phase).toBe("local"), { timeout: 8_000 });
    const saved = await first.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Lab",
      host: "test-host.invalid",
      serverPort: server.port,
    });
    const ssh = saved.profiles.find((profile) => profile.kind === "ssh")!;
    await first.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await vi.waitFor(async () => expect((await first.view()).status.phase).toBe("connected"), { timeout: 8_000 });
    expect(sshCalls).toEqual([{ host: "test-host.invalid", interactive: true }]);
    expect(autoPairCalls).toEqual(["test-host.invalid"]);

    // Switch back to local (instant!), then add a second UNPAIRED SSH profile.
    await first.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    await first.invoke(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Unpaired",
      host: "unpaired-host.invalid",
      serverPort: server.port,
    });
    await first.dispose();

    // Restart with askpass enabled: the paired SSH profile connects in the background with interactive: false
    // and never auto-pairs or prompts SSH; the unpaired SSH profile does not auto-connect at all.
    sshCalls.length = 0;
    autoPairCalls.length = 0;
    const second = await desktop(first.directory, first.key, { fakeAskpass: true, openSshTunnel: openFakeTunnel });
    await vi.waitFor(async () => expect((await second.view()).status.phase).toBe("local"), { timeout: 8_000 });
    await vi.waitFor(async () => expect((await second.view()).environments?.[ssh.id]?.phase).toBe("connected"), {
      timeout: 8_000,
    });
    expect(sshCalls).toEqual([{ host: "test-host.invalid", interactive: false }]);
    expect(autoPairCalls).toEqual([]);
    expect((await second.view()).sshPrompt).toBeUndefined();

    // Switching to the already-connected background SSH profile is instantaneous without opening another tunnel!
    const countBeforeSwitch = sshCalls.length;
    const promoted = await second.invoke<ConnectionsView>(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    expect(promoted.status.phase).toBe("connected");
    expect(sshCalls.length).toBe(countBeforeSwitch);

    // Explicitly calling connectEnvironment on the unpaired SSH profile runs non-interactively,
    // never auto-pairs, and settles in pairing_required.
    const unpaired = (await second.view()).profiles.find((profile) => profile.name === "Unpaired")!;
    await second.invoke(WISP_IPC_CHANNELS.connectEnvironment, { id: unpaired.id });
    await vi.waitFor(
      async () => expect((await second.view()).environments?.[unpaired.id]?.phase).toBe("pairing_required"),
      { timeout: 8_000 },
    );
    expect(sshCalls.filter((call) => call.host === "unpaired-host.invalid")).toEqual([
      { host: "unpaired-host.invalid", interactive: false },
    ]);
    expect(autoPairCalls).toEqual([]);
    expect((await second.view()).sshPrompt).toBeUndefined();
    expect((await second.view()).profiles.find((profile) => profile.id === unpaired.id)?.paired).toBe(false);
  });

  it("evicts pooled background sessions when removed or edited to a new address, checks all on wake, and cleans up on dispose", async () => {
    const { server: serverA } = await startServer();
    const { server: serverB } = await startServer();
    const app = await desktop();
    await vi.waitFor(async () => expect((await app.view()).status.phase).toBe("local"), { timeout: 8_000 });

    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Server A",
      url: serverA.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    const code = await pairCode(serverA);
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await vi.waitFor(async () => expect((await app.view()).status.phase).toBe("connected"), { timeout: 8_000 });

    // Switch back to local while remote stays connected in the background.
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    expect((await app.view()).environments?.[remote.id]?.phase).toBe("connected");

    // Wake check runs safely across every open pooled session.
    expect(() => app.triggerWake()).not.toThrow();

    // Changing the background profile's address evicts its old pooled session and clears pairing.
    const edited = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      id: remote.id,
      kind: "url",
      name: "Server B",
      url: serverB.url,
    });
    expect(edited.profiles.find((profile) => profile.id === remote.id)?.paired).toBe(false);
    expect(edited.environments?.[remote.id]?.phase).toBe("pairing_required");
    expect(
      await app.call(WISP_IPC_CHANNELS.invokeConnectionOperation, {
        connectionId: remote.id,
        operation: "getAiSettings",
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });

    // Removing the background profile cleans it from environments.
    const removed = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.removeConnection, { id: remote.id });
    expect(removed.environments?.[remote.id]).toBeUndefined();

    // Disposing cleanly stops the local server too.
    await app.dispose();
    expect(app.localServer.server).toBeUndefined();
  });
});
