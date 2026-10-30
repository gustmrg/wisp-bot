import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpConnectionAuth } from "../../backend/mcp-bridge.js";
import type { McpOAuthProvider } from "../../backend/mcp-oauth.js";
import { StructuredLogger } from "../../backend/structured-logger.js";
import { RemoteClient } from "../../client/remote-client.js";
import { LaunchAtLoginService } from "../../electron/backend/launch-at-login-service.js";
import { UpdateService } from "../../electron/backend/update-service.js";
import { SshAskpass } from "../../electron/connections/ssh-askpass.js";
import { installRemoteServer } from "../../electron/connections/ssh-install.js";
import { testSshConnection } from "../../electron/connections/ssh-test.js";
import { openSshTunnel } from "../../electron/connections/ssh-tunnel.js";
import { createBackend, type Backend } from "../../electron/create-backend.js";
import { Tailscale } from "../../electron/local-server/tailscale.js";
import { FakeTailscale } from "../helpers/fake-tailscale.js";
import { InProcessLocalServer } from "../helpers/in-process-local-server.js";
import { adminRequest } from "../../server/admin.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";
import type { ConnectionsView } from "../../shared/connections.js";
import { WISP_IPC_CHANNELS, type BackendResult } from "../../shared/contracts.js";
import type { ConversationStateView } from "../../shared/conversations.js";
import type { McpSettingsView } from "../../shared/mcp.js";
import type { RemoteAccessPairing, RemoteAccessView } from "../../shared/remote-access.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => Promise<BackendResult<unknown>>;

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const fakeSsh = path.join(__dirname, "../fixtures/fake-ssh.cjs");
const TEST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3Q= wisp@laptop";
const cleanups: Array<() => Promise<void> | void> = [];
const environment = { ...process.env };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.env = { ...environment };
});

/** Sets up a new store with one Wisp, as the app does on a first run. */
async function createLocalWisp(app: { invoke: (channel: string, payload?: unknown) => Promise<unknown> }) {
  await app.invoke(WISP_IPC_CHANNELS.initializeConversations);
  await app.invoke(WISP_IPC_CHANNELS.createWisp, {
    wisp: { id: "local", name: "Local", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
    notifyOnUpdatesEnabled: true,
  });
}

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

/** Another HTTP service on the loopback, as on a server where Wisp's port is taken, counting what it was asked. */
async function anotherService(port = 0): Promise<{ port: number; requests: number }> {
  const service = { port: 0, requests: 0 };
  const http = createHttpServer((_request, response) => {
    service.requests++;
    response.writeHead(404, { "Content-Type": "text/html" });
    response.end("<h1>Not found</h1>");
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  service.port = (http.address() as AddressInfo).port;
  return service;
}

/** Each step of the connection's progress, with its state. */
const stepsOf = (view: ConnectionsView) => view.status.progress?.steps.map(({ id, state }) => [id, state]);

/** The desktop backend with fake IPC; reopening the same directory simulates a restart. */
/** Pass `choose: false` to stay at the first-run choice, and `askpass: true` to let SSH ask questions. */
async function desktop(
  userData?: string,
  key = randomBytes(32),
  { choose = true, askpass = false }: { choose?: boolean; askpass?: boolean } = {},
) {
  const directory = userData ?? (await temporaryDirectory("wisp-desktop-"));
  const handlers = new Map<string, Handler>();
  const broadcasts: Array<[string, unknown]> = [];
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  const localServer = new InProcessLocalServer(directory, key);
  const tailscale = new FakeTailscale();
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
    appVersion: "1.0.0",
    fetch: tailscale.fetch,
    tailscale: new Tailscale({ locate: tailscale.locate, run: tailscale.run }),
    testSshConnection: (profile, options) => testSshConnection(profile, { ...options, sshPath: fakeSsh }),
    ...(askpass ? { startSshAskpass: () => SshAskpass.start() } : {}),
    openSshTunnel: (profile, signal, interaction, onServerPort) =>
      openSshTunnel(profile, {
        sshPath: fakeSsh,
        signal,
        onServerPort,
        ...(interaction ? { interaction: { ...interaction, publicKeys: async () => [TEST_KEY] } } : {}),
      }),
    installServer: (profile, onProgress, signal, interaction) =>
      installRemoteServer(profile, {
        sshPath: fakeSsh,
        version: "1.0.0",
        onProgress,
        signal,
        ...(interaction ? { interaction } : {}),
      }),
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
  if (choose && (await view()).status.phase === "choosing") {
    await invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
  }
  return {
    directory,
    key,
    localServer,
    tailscale,
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

/**
 * Stands in for the MCP SDK on the server: starts a browser sign-in through
 * the real OAuth provider, waits for the redirect, and stores a token as the
 * code exchange would. No MCP or OAuth server is contacted.
 */
class BrowserSignInConnection {
  private status: "connected" | "idle" = "idle";

  get connectionStatus(): "connected" | "idle" {
    return this.status;
  }

  async connect(
    _endpoint: string,
    auth: McpConnectionAuth,
    options: { allowInteractiveSignIn?: boolean } = {},
  ): Promise<"connected" | "needs_sign_in"> {
    const provider = (auth as { provider: McpOAuthProvider }).provider;
    provider.setInteractiveSignIn(options.allowInteractiveSignIn === true);
    const state = provider.state();
    provider.saveCodeVerifier("verifier");
    try {
      const redirect = encodeURIComponent(provider.redirectUrl);
      await provider.redirectToAuthorization(
        new URL(`https://auth.example.com/authorize?state=${state}&redirect_uri=${redirect}`),
      );
    } catch {
      return "needs_sign_in";
    } finally {
      provider.setInteractiveSignIn(false);
    }
    const callback = await provider.waitForCallback().catch(() => undefined);
    if (callback?.get("code") !== "relayed-code") return "needs_sign_in";
    provider.saveTokens({ access_token: "relayed-token", token_type: "Bearer" });
    this.status = "connected";
    return "connected";
  }

  async listTools() {
    return [{ name: "search", description: "Search", inputSchema: { type: "object" } }];
  }

  async callTool() {
    return { content: [] };
  }

  async close() {
    this.status = "idle";
  }
}

describe("desktop connections", () => {
  it("runs nothing on a new installation until this computer or a server is chosen", async () => {
    const app = await desktop(undefined, undefined, { choose: false });
    expect((await app.view()).status.phase).toBe("choosing");
    expect(app.localServer.starts).toBe(0);
    expect(await app.call(WISP_IPC_CHANNELS.getConversationState)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    // Adding a server is not a choice yet: a restart still asks.
    await app.invoke(WISP_IPC_CHANNELS.saveConnection, { kind: "url", name: "Later", url: "http://127.0.0.1:9" });
    await app.dispose();
    const restarted = await desktop(app.directory, app.key, { choose: false });
    expect((await restarted.view()).status.phase).toBe("choosing");

    await restarted.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    await restarted.waitForPhase("local");
    await restarted.dispose();
    const chosen = await desktop(app.directory, app.key, { choose: false });
    await chosen.waitForPhase("local");
  });

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
    await createLocalWisp(app);
    expect(await app.chats()).toEqual(["local"]);
    expect(app.localServer.starts).toBe(1);
    expect(app.localServer.server?.auth.devices()).toEqual([
      expect.objectContaining({ name: "Test computer", local: true }),
    ]);
  });

  it("does what the local server asks on this computer's screen", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    await createLocalWisp(app);
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
    await createLocalWisp(app);
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
    await app.invoke(WISP_IPC_CHANNELS.createWisp, {
      wisp: { id: "remote", name: "Remote", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE },
      notifyOnUpdatesEnabled: true,
    });
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
    // Files picked on this computer are sent to the server's workspace.
    const attachment = path.join(app.directory, "notes.txt");
    await writeFile(attachment, "hello");
    app.hostActions.selectFiles.mockResolvedValueOnce([attachment]);
    expect(await app.invoke(WISP_IPC_CHANNELS.attachWorkspaceFiles, { conversationId: "remote" })).toEqual({
      files: [{ name: "notes.txt", path: "inbox/notes.txt", size: 5 }],
      workspace: expect.objectContaining({ usedBytes: 5 }),
    });
    expect(await server.runtime.workspace.getView("remote")).toMatchObject({ usedBytes: 5 });
    app.hostActions.selectFiles.mockResolvedValueOnce([app.directory]);
    expect(await app.call(WISP_IPC_CHANNELS.attachWorkspaceFiles, { conversationId: "remote" })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("is not a readable file") },
    });
    // Wisps on this computer stopped when the server was chosen.
    expect(app.localServer.server).toBeUndefined();

    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    await app.waitForPhase("local");
    expect(await app.chats()).toEqual(["local"]);
    // The server kept its Wisp.
    expect(Object.keys(server.runtime.conversations.getState().chats)).toEqual(["remote"]);
  });

  it("signs in to an MCP server for a server on another computer through this app's browser", async () => {
    const { server, directory: serverDirectory } = await startServer();
    (server.runtime.mcp as unknown as { options: { createConnection: () => unknown } }).options.createConnection = () =>
      new BrowserSignInConnection();
    const app = await desktop();
    await app.waitForPhase("local");
    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    const { code } = (await adminRequest(serverDirectory, { command: "pair" })) as { code: string };
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await app.waitForPhase("connected");
    // The paired device is this app on another computer, not the server's own.
    expect(server.auth.devices()).toEqual([expect.objectContaining({ local: false })]);

    const saved = await app.invoke<McpSettingsView>(WISP_IPC_CHANNELS.saveMcpServer, {
      name: "Docs",
      endpoint: "https://mcp.example.com/mcp",
      authMode: "oauth",
      enabled: true,
    });
    const serverId = saved.servers[0]!.serverId;
    const signIn = app.call<McpSettingsView>(WISP_IPC_CHANNELS.startMcpSignIn, { serverId });

    // This app opens the page in its own browser, for a redirect to its own loopback.
    await vi.waitFor(() => expect(app.hostActions.openExternal).toHaveBeenCalledTimes(1), { timeout: 8_000 });
    const page = new URL(app.hostActions.openExternal.mock.calls[0]![0] as string);
    const redirect = new URL(page.searchParams.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    const state = page.searchParams.get("state")!;
    // A forged redirect is refused; the real one completes the sign-in on the server.
    expect((await fetch(`${redirect}?code=relayed-code&state=forged`)).status).toBe(400);
    expect((await fetch(`${redirect}?code=relayed-code&state=${state}`)).status).toBe(200);

    const result = await signIn;
    expect(result).toMatchObject({ ok: true, value: { servers: [expect.objectContaining({ state: "connected" })] } });
    await vi.waitFor(async () =>
      expect(
        await (
          server.runtime.mcp as unknown as { secrets: { oauthTokens(id: string): Promise<unknown> } }
        ).secrets.oauthTokens(serverId),
      ).toMatchObject({ accessToken: "relayed-token" }),
    );
    // The listener on this computer served one redirect and closed.
    await vi.waitFor(() => expect(fetch(`${redirect}?code=relayed-code&state=${state}`)).rejects.toThrow());
  });

  it("ends a relayed sign-in when this app leaves the server", async () => {
    const { server, directory: serverDirectory } = await startServer();
    (server.runtime.mcp as unknown as { options: { createConnection: () => unknown } }).options.createConnection = () =>
      new BrowserSignInConnection();
    const app = await desktop();
    await app.waitForPhase("local");
    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    const { code } = (await adminRequest(serverDirectory, { command: "pair" })) as { code: string };
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id, pairingCode: code });
    await app.waitForPhase("connected");
    const saved = await app.invoke<McpSettingsView>(WISP_IPC_CHANNELS.saveMcpServer, {
      name: "Docs",
      endpoint: "https://mcp.example.com/mcp",
      authMode: "oauth",
      enabled: true,
    });
    const serverId = saved.servers[0]!.serverId;
    const signIn = app.call<McpSettingsView>(WISP_IPC_CHANNELS.startMcpSignIn, { serverId });
    signIn.catch(() => undefined);
    await vi.waitFor(() => expect(app.hostActions.openExternal).toHaveBeenCalledTimes(1), { timeout: 8_000 });
    const page = new URL(app.hostActions.openExternal.mock.calls[0]![0] as string);
    const redirect = page.searchParams.get("redirect_uri")!;

    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    await app.waitForPhase("local");
    // Nothing on this computer still listens for the redirect, and the server stored nothing.
    await expect(fetch(`${redirect}?code=relayed-code&state=${page.searchParams.get("state")}`)).rejects.toThrow();
    await vi.waitFor(
      async () => expect((await server.runtime.mcp.getView()).servers[0]?.signInPending).toBeUndefined(),
      {
        timeout: 8_000,
      },
    );
    expect(
      await (
        server.runtime.mcp as unknown as { secrets: { oauthTokens(id: string): Promise<unknown> } }
      ).secrets.oauthTokens(serverId),
    ).toBeUndefined();
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

    // A dropped connection is not a failed attempt: the attempts after it are.
    await server.close();
    await app.waitForPhase("reconnecting");
    await vi.waitFor(async () => expect((await app.view()).status.retry?.attempt).toBeGreaterThan(0), {
      timeout: 8_000,
    });
    const { retry } = (await app.view()).status;
    expect(retry?.failures.length).toBe(retry?.attempt);
    expect(retry?.failures[0]?.message).toMatch(/nothing answers on its port/);
  });

  it("finds the server's port over SSH when another service answers on the one given", async () => {
    const { server, directory: serverDirectory } = await startServer();
    process.env.FAKE_WISP_DATA_DIR = serverDirectory;
    const log = path.join(serverDirectory, "ssh.log");
    process.env.FAKE_SSH_LOG = log;
    const other = await anotherService();
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: other.port,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await app.waitForPhase("connected");
    // Corrected without a failed attempt, and paired once, with the code got on the wrong port.
    const view = await app.view();
    expect(view.profiles.find((profile) => profile.id === ssh.id)).toMatchObject({ serverPort: server.port });
    expect(view.status.retry).toBeUndefined();
    expect(server.auth.devices()).toEqual([expect.objectContaining({ name: "Test computer" })]);
    expect(other.requests).toBe(0);
    const forwards = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .flatMap((args) => (args.includes("-L") ? [args[args.indexOf("-L") + 1]?.split(":").at(-1)] : []));
    expect(forwards).toEqual([String(other.port), String(server.port)]);
  });

  it("follows a paired server to its new port and keeps the pairing", async () => {
    const key = randomBytes(32);
    const directory = await temporaryDirectory("wisp-remote-");
    const start = (port = 0) =>
      createWispServer({
        dataDirectory: directory,
        host: "127.0.0.1",
        port,
        encryption: new MasterKeyEncryption(key),
        logger: silent,
        agentMode: "fake",
        appVersion: "1.0.0",
        allowModelNetwork: false,
      });
    const first = await start();
    const oldPort = first.port;
    process.env.FAKE_WISP_DATA_DIR = directory;
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: oldPort,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await app.waitForPhase("connected");

    // The server moves to another port, and another service takes its old one.
    await first.close();
    const other = await anotherService(oldPort);
    const moved = await start();
    cleanups.push(() => moved.close());
    await vi.waitFor(
      async () => {
        const view = await app.view();
        expect(view.profiles.find((profile) => profile.id === ssh.id)).toMatchObject({ serverPort: moved.port });
        expect(view.status.phase).toBe("connected");
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(other.requests).toBeGreaterThan(0);
    expect(moved.auth.devices()).toEqual([expect.objectContaining({ name: "Test computer" })]);
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

  it("shows the step an SSH connection failed at, what kind of failure it was, and what OpenSSH said", async () => {
    process.env.FAKE_SSH_FAIL = "denied";
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
    const view = await app.view();
    expect(view.status).toMatchObject({ failure: "auth", details: expect.stringMatching(/Permission denied/) });
    expect(stepsOf(view)).toEqual([
      ["reach", "done"],
      ["sign_in", "failed"],
      ["pair", "pending"],
      ["server", "pending"],
      ["load", "pending"],
    ]);
  });

  it("retries a host it cannot reach, says when it tries next, and stops on request", async () => {
    process.env.FAKE_SSH_FAIL = "resolve";
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "nowhere",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await vi.waitFor(async () => expect((await app.view()).status.retry?.attempt).toBeGreaterThan(0), {
      timeout: 8_000,
    });
    const { status } = await app.view();
    expect(status).toMatchObject({ phase: "connecting", failure: "unreachable" });
    expect(status.retry).toMatchObject({
      nextAttemptAt: expect.any(Number),
      failures: [{ message: expect.stringMatching(/nowhere could not be resolved/) }],
    });
    expect(stepsOf(await app.view())?.[0]).toEqual(["reach", "failed"]);

    await app.invoke(WISP_IPC_CHANNELS.cancelConnection);
    const cancelled = (await app.view()).status;
    expect(cancelled).toMatchObject({ phase: "error", failure: "cancelled" });
    expect(cancelled.retry).toBeUndefined();
  });

  it("asks to trust a new host key and for a password, then connects with this computer's key", async () => {
    const { server, directory: serverDirectory } = await startServer();
    process.env.FAKE_WISP_DATA_DIR = serverDirectory;
    process.env.FAKE_SSH_ASK = "hostkey,password";
    process.env.FAKE_SSH_KNOWN = path.join(serverDirectory, "known_hosts");
    process.env.FAKE_SSH_AUTHORIZED = path.join(serverDirectory, "authorized_keys");
    const app = await desktop(undefined, undefined, { askpass: true });
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Home",
      host: "home-server",
      serverPort: server.port,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    const prompt = async (kind: string) => {
      let found: ConnectionsView["sshPrompt"];
      await vi.waitFor(
        async () => {
          found = (await app.view()).sshPrompt;
          expect(found?.kind).toBe(kind);
        },
        { timeout: 8_000, interval: 25 },
      );
      return found!;
    };
    const hostKey = await prompt("host_key");
    // OpenSSH reached the host: signing in waits on the person.
    expect(stepsOf(await app.view())?.slice(0, 2)).toEqual([
      ["reach", "done"],
      ["sign_in", "active"],
    ]);
    expect(hostKey).toMatchObject({ host: "home-server", message: expect.stringMatching(/SHA256:fakefakefake/) });
    await app.invoke(WISP_IPC_CHANNELS.answerSshPrompt, { id: hostKey.id, answer: "yes" });
    const password = await prompt("password");
    expect(password.keys).toEqual([expect.stringMatching(/^wisp@laptop \(SHA256:/)]);
    await app.invoke(WISP_IPC_CHANNELS.answerSshPrompt, { id: password.id, answer: "hunter2" });
    await app.waitForPhase("connected");
    expect((await app.view()).sshPrompt).toBeUndefined();
    expect(await readFile(process.env.FAKE_SSH_AUTHORIZED, "utf8")).toBe(`${TEST_KEY}\n`);
    // Pairing over SSH already used the key, and so does the next connection.
    await app.invoke(WISP_IPC_CHANNELS.retryConnection);
    await app.waitForPhase("connected");
    expect((await app.view()).sshPrompt).toBeUndefined();
  });

  it("stops connecting when an SSH question is declined", async () => {
    const directory = await temporaryDirectory("wisp-ssh-");
    process.env.FAKE_SSH_ASK = "hostkey";
    process.env.FAKE_SSH_KNOWN = path.join(directory, "known_hosts");
    const app = await desktop(undefined, undefined, { askpass: true });
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Home",
      host: "home-server",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await vi.waitFor(async () => expect((await app.view()).sshPrompt).toBeDefined(), { timeout: 8_000 });
    const { id } = (await app.view()).sshPrompt!;
    expect(await app.call(WISP_IPC_CHANNELS.answerSshPrompt, { id, answer: 7 })).toMatchObject({ ok: false });
    await app.invoke(WISP_IPC_CHANNELS.answerSshPrompt, { id });
    await app.waitForPhase("error");
    expect((await app.view()).status.message).toMatch(/did not connect to home-server, because its SSH host key/);
  });

  it("sets the server up over SSH, then connects and pairs", async () => {
    const { server, directory: serverDirectory } = await startServer();
    process.env.FAKE_WISP_DATA_DIR = serverDirectory;
    const log = path.join(serverDirectory, "ssh.log");
    process.env.FAKE_SSH_LOG = log;
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: server.port,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    const view = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.installServer, { id: ssh.id });
    expect(view.activeId).toBe(ssh.id);
    await app.waitForPhase("connected");
    expect(server.auth.devices()).toEqual([expect.objectContaining({ name: "Test computer" })]);
    expect((await app.view()).status.progress).toBeUndefined();

    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]?.slice(-2)).toEqual([
      "raspberrypi",
      `sh -c 'PATH="$HOME/.local/bin:$PATH"; echo "Connected. Downloading the Wisp server…" >&2; d=$(mktemp -d) || exit 1; npm install --prefix "$d" --no-audit --no-fund --loglevel=error @gustmrg/wisp-server@1.0.0 >&2 && node "$d/node_modules/@gustmrg/wisp-server/server/cli.js" setup --json --no-pair --until-stdin-closes --port ${server.port}; s=$?; rm -rf "$d"; exit $s'`,
    ]);
  });

  it("explains why setting the server up failed and lets the person retry", async () => {
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    for (const [mode, message] of [
      ["no-node", /Node\.js is missing on raspberrypi/],
      ["not-published", /server 1\.0\.0 is not published on npm/],
      ["systemd", /Could not set up the Wisp server on raspberrypi: The systemd user session/],
    ] as const) {
      process.env.FAKE_SSH_INSTALL = mode;
      const result = await app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "unavailable", message: expect.stringMatching(message) },
      });
    }
    // Nothing changed for the connection that was in use.
    expect((await app.view()).activeId).toBe("local");

    // Setting up the server in use shows the step that failed; nothing after it runs.
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    process.env.FAKE_SSH_INSTALL = "no-node";
    expect(await app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id })).toMatchObject({ ok: false });
    expect((await app.view()).status).toMatchObject({ phase: "error", failure: "node" });
    expect(stepsOf(await app.view())).toEqual([
      ["reach", "done"],
      ["sign_in", "done"],
      ["download", "failed"],
      ["install", "skipped"],
      ["service", "skipped"],
      ["connect", "skipped"],
    ]);
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    expect(await app.call(WISP_IPC_CHANNELS.installServer, { id: "local" })).toMatchObject({ ok: false });
    expect(await app.call(WISP_IPC_CHANNELS.installServer, { id: "nowhere" })).toMatchObject({ ok: false });
  });

  it("shows reaching the host and signing in as their own steps before downloading the server", async () => {
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "test-host.invalid",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    for (const [mode, failure, steps] of [
      ["resolve", "unreachable", [["reach", "failed"]]],
      [
        "denied",
        "auth",
        [
          ["reach", "done"],
          ["sign_in", "failed"],
        ],
      ],
    ] as const) {
      process.env.FAKE_SSH_FAIL = mode;
      expect(await app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id })).toMatchObject({ ok: false });
      expect((await app.view()).status).toMatchObject({ phase: "error", failure });
      const shown = stepsOf(await app.view());
      expect(shown?.slice(0, steps.length)).toEqual(steps);
      expect(shown?.slice(steps.length).every(([, state]) => state === "skipped")).toBe(true);
    }
  });

  it("waits on the person at signing in when SSH asks a question while setting the server up", async () => {
    const directory = await temporaryDirectory("wisp-ssh-");
    process.env.FAKE_SSH_ASK = "hostkey";
    process.env.FAKE_SSH_KNOWN = path.join(directory, "known_hosts");
    process.env.FAKE_SSH_INSTALL = "hang";
    const app = await desktop(undefined, undefined, { askpass: true });
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Home",
      host: "home-server",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    // The connection fails on the question it cannot answer yet; the setup asks it again.
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });
    await vi.waitFor(async () => expect((await app.view()).sshPrompt).toBeDefined(), { timeout: 8_000 });
    await app.invoke(WISP_IPC_CHANNELS.answerSshPrompt, { id: (await app.view()).sshPrompt!.id });
    await app.waitForPhase("error");

    const installing = app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id });
    await vi.waitFor(async () => expect((await app.view()).sshPrompt?.kind).toBe("host_key"), { timeout: 8_000 });
    expect(stepsOf(await app.view())?.slice(0, 3)).toEqual([
      ["reach", "done"],
      ["sign_in", "active"],
      ["download", "pending"],
    ]);
    await app.invoke(WISP_IPC_CHANNELS.answerSshPrompt, { id: (await app.view()).sshPrompt!.id, answer: "yes" });
    await vi.waitFor(async () =>
      expect((await app.view()).status.progress?.steps[3]).toMatchObject({ id: "install", state: "active" }),
    );
    expect(stepsOf(await app.view())?.slice(0, 3)).toEqual([
      ["reach", "done"],
      ["sign_in", "done"],
      ["download", "done"],
    ]);
    await app.invoke(WISP_IPC_CHANNELS.cancelServerInstall);
    expect(await installing).toMatchObject({ ok: false });
  });

  it("does not hold up other requests while setting a server up, and cancels it on request", async () => {
    process.env.FAKE_SSH_INSTALL = "hang";
    const app = await desktop();
    const { profiles } = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "ssh",
      name: "Pi",
      host: "raspberrypi",
      serverPort: 8787,
    });
    const ssh = profiles.find((profile) => profile.kind === "ssh")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: ssh.id });

    const installing = app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id });
    await vi.waitFor(async () => expect((await app.view()).status).toMatchObject({ installing: true }));
    // The setup reports where it is.
    await vi.waitFor(async () =>
      expect((await app.view()).status.progress?.steps[3]).toMatchObject({
        id: "install",
        state: "active",
        detail: expect.stringMatching(/^Installing /),
      }),
    );
    expect((await app.view()).status.progress?.kind).toBe("install");
    expect(await app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/already setting up/) },
    });
    // Editing a connection does not wait for the setup.
    await app.invoke(WISP_IPC_CHANNELS.saveConnection, { kind: "url", name: "Tailnet", url: "https://x.ts.net" });

    await app.invoke(WISP_IPC_CHANNELS.cancelServerInstall);
    expect(await installing).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cancelled/) } });
    expect((await app.view()).status).toMatchObject({ profileId: ssh.id, phase: "error", failure: "cancelled" });
    expect((await app.view()).status.installing).toBeUndefined();
    expect(stepsOf(await app.view())).toEqual([
      ["reach", "done"],
      ["sign_in", "done"],
      ["download", "done"],
      ["install", "skipped"],
      ["service", "skipped"],
      ["connect", "skipped"],
    ]);

    // Choosing another connection cancels a setup, too, and wins.
    const again = app.call(WISP_IPC_CHANNELS.installServer, { id: ssh.id });
    await vi.waitFor(async () => expect((await app.view()).status).toMatchObject({ installing: true }));
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: "local" });
    expect(await again).toMatchObject({ ok: false, error: { message: expect.stringMatching(/cancelled/) } });
    expect((await app.view()).activeId).toBe("local");
    await app.waitForPhase("local");
  });
});

it("tests an unsaved SSH profile without changing the active connection or saving it", async () => {
  const app = await desktop(undefined, undefined, { choose: false });
  const before = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.getConnections);
  const draft = { kind: "ssh", name: "Unsaved", host: "example", user: "me", sshPort: 2222, serverPort: 8787 };
  expect(await app.invoke(WISP_IPC_CHANNELS.testSshConnection, draft)).toMatchObject({
    message: expect.stringContaining("successful"),
  });
  expect(await app.invoke(WISP_IPC_CHANNELS.getConnections)).toEqual(before);
  process.env.FAKE_SSH_FAIL = "denied";
  expect(await app.call(WISP_IPC_CHANNELS.testSshConnection, draft)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("authentication failed") },
  });
  expect(await app.call(WISP_IPC_CHANNELS.testSshConnection, { ...draft, host: "-oProxyCommand=bad" })).toMatchObject({
    ok: false,
    error: { code: "invalid_request" },
  });
});

/** A loopback port nothing listens on, for a server that needs a fixed one. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Whether a Wisp server answers on a loopback port, on a new connection each time. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    httpGet(`http://127.0.0.1:${port}/health`, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    }).on("error", () => resolve(false));
  });
}

/** Another device, such as a phone, that pairs with a server over HTTP. */
function phone(baseUrl: string) {
  let stored: DeviceCredentials | undefined;
  return new RemoteClient({
    baseUrl,
    credentials: {
      load: () => stored,
      save: async (credentials) => {
        stored = credentials;
      },
    },
  });
}

describe("remote access to this computer", () => {
  const origin = "https://laptop.tailnet.ts.net";

  it("is off until turned on, and refuses addresses other than an HTTPS origin", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    expect(await app.invoke(WISP_IPC_CHANNELS.getRemoteAccess)).toEqual({
      enabled: false,
      automatic: false,
      port: 8787,
      webAppAvailable: false,
      devices: [],
      tailscale: { status: "ready", origin: "https://laptop.tailnet.ts.net", httpsEnabled: true },
    });
    for (const [request, message] of [
      [{ enabled: true, port: 8787 }, "Enter the HTTPS address"],
      [{ enabled: true, port: 8787, publicOrigin: "http://laptop.tailnet.ts.net" }, "Enter an HTTPS address"],
      [{ enabled: true, port: 8787, publicOrigin: `${origin}/wisp` }, "Enter an HTTPS address"],
      [{ enabled: true, port: 80, publicOrigin: origin }, "between 1024 and 65535"],
    ] as const) {
      expect(await app.call(WISP_IPC_CHANNELS.saveRemoteAccess, request)).toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: expect.stringContaining(message) },
      });
    }
    expect(await app.call(WISP_IPC_CHANNELS.pairRemoteDevice)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Turn on remote access") },
    });
    expect(app.localServer.starts).toBe(1);
  });

  it("turns on without restarting Wisps on this computer, so the app never reconnects", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    const { epoch } = (await app.view()).status;
    const port = await freePort();
    // As if tailscale serve --bg had been run by hand.
    app.tailscale.serveByHand(port);
    await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, publicOrigin: origin });
    expect(await answers(port)).toBe(true);
    await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: false, port, publicOrigin: origin });
    expect(await answers(port)).toBe(false);
    expect(app.localServer.starts).toBe(1);
    expect((await app.view()).status).toMatchObject({ phase: "local", epoch });
  });

  it("turns on only when the address reaches this computer, and says what to fix when it does not", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    const port = await freePort();
    // As if tailscale serve --bg had been run by hand.
    app.tailscale.serveByHand(port);
    for (const [publicOrigin, message] of [
      ["https://desktop.tailnet.ts.net", "could not reach https://desktop.tailnet.ts.net"],
      ["https://stale.tailnet.ts.net", "answers, but Wisp does not"],
    ] as const) {
      expect(await app.call(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, publicOrigin })).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(message) },
      });
      expect(await app.invoke(WISP_IPC_CHANNELS.getRemoteAccess)).toMatchObject({ enabled: false, port: 8787 });
    }
    // The port closed again, and nothing was saved.
    expect(await answers(port)).toBe(false);
    await expect(readFile(path.join(app.directory, "remote-access.json"))).rejects.toThrow();

    // A port another program uses is refused with that reason.
    const taken = createNetServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const takenPort = (taken.address() as AddressInfo).port;
    expect(
      await app.call(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port: takenPort, publicOrigin: origin }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining(`already uses port ${takenPort}`) } });

    expect(
      await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, publicOrigin: origin }),
    ).toMatchObject({ enabled: true, publicOrigin: origin });
    // Editing the address to one that does not reach this computer keeps the working one.
    expect(
      await app.call(WISP_IPC_CHANNELS.saveRemoteAccess, {
        enabled: true,
        port,
        publicOrigin: "https://desktop.tailnet.ts.net",
      }),
    ).toMatchObject({ ok: false });
    expect(await app.invoke(WISP_IPC_CHANNELS.getRemoteAccess)).toMatchObject({ enabled: true, publicOrigin: origin });
    expect(await answers(port)).toBe(true);
  });

  it("pairs a device with a QR code link, lists only other devices, and revokes them", async () => {
    const app = await desktop();
    await app.waitForPhase("local");
    const port = await freePort();
    // As if tailscale serve --bg had been run by hand.
    app.tailscale.serveByHand(port);
    const view = await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.saveRemoteAccess, {
      enabled: true,
      port,
      publicOrigin: `${origin}/`,
    });
    expect(view).toMatchObject({ enabled: true, port, publicOrigin: origin, devices: [] });

    const pairing = await app.invoke<RemoteAccessPairing>(WISP_IPC_CHANNELS.pairRemoteDevice);
    expect(pairing.link).toBe(`${origin}/#pair=${pairing.code}`);
    await phone(`http://127.0.0.1:${port}`).pair(pairing.code, "Chrome on Android");

    const { devices } = await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.getRemoteAccess);
    expect(devices).toEqual([expect.objectContaining({ name: "Chrome on Android" })]);
    // This computer's own app is never listed, nor revoked.
    const own = app.localServer.server!.auth.devices().find(({ local }) => local)!;
    expect(await app.call(WISP_IPC_CHANNELS.revokeRemoteDevice, { deviceId: own.id })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("cannot be revoked") },
    });
    const revoked = await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.revokeRemoteDevice, {
      deviceId: devices[0]!.id,
    });
    expect(revoked.devices).toEqual([]);
    // A pairing code is single-use.
    await expect(phone(`http://127.0.0.1:${port}`).pair(pairing.code, "Again")).rejects.toThrow();
  });

  it("keeps Wisps on this computer running while another connection is chosen, until it is turned off", async () => {
    const { server } = await startServer();
    const app = await desktop();
    await app.waitForPhase("local");
    const port = await freePort();
    // As if tailscale serve --bg had been run by hand.
    app.tailscale.serveByHand(port);
    await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, publicOrigin: origin });
    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    const remote = added.profiles.find((profile) => profile.kind === "url")!;
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, { id: remote.id });
    await app.waitForPhase("pairing_required");
    expect(app.localServer.server).toBeDefined();
    expect(await answers(port)).toBe(true);

    await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: false, port, publicOrigin: origin });
    expect(app.localServer.server).toBeUndefined();
    // The address is kept for the next time it is turned on.
    expect(await app.invoke(WISP_IPC_CHANNELS.getRemoteAccess)).toMatchObject({
      enabled: false,
      port,
      publicOrigin: origin,
    });
  });

  it("starts exposed after a restart, even when a server is the chosen connection", async () => {
    const { server } = await startServer();
    const app = await desktop();
    await app.waitForPhase("local");
    const port = await freePort();
    // As if tailscale serve --bg had been run by hand.
    app.tailscale.serveByHand(port);
    await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, publicOrigin: origin });
    const added = await app.invoke<ConnectionsView>(WISP_IPC_CHANNELS.saveConnection, {
      kind: "url",
      name: "Home server",
      url: server.url,
    });
    await app.invoke(WISP_IPC_CHANNELS.activateConnection, {
      id: added.profiles.find((profile) => profile.kind === "url")!.id,
    });
    await app.dispose();
    expect(await answers(port)).toBe(false);

    const restarted = await desktop(app.directory, app.key, { choose: false });
    await restarted.waitForPhase("pairing_required");
    await vi.waitFor(async () => expect(await answers(port)).toBe(true), { timeout: 8_000 });
    expect(await restarted.invoke(WISP_IPC_CHANNELS.getRemoteAccess)).toMatchObject({ enabled: true });
  });

  describe("set up by Wisp with Tailscale Serve", () => {
    it("serves this computer, then removes only that serve when turned off", async () => {
      const app = await desktop();
      await app.waitForPhase("local");
      const port = await freePort();
      const view = await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.saveRemoteAccess, {
        enabled: true,
        port,
        automatic: true,
      });
      expect(view).toMatchObject({ enabled: true, automatic: true, publicOrigin: origin, port });
      expect(app.tailscale.handler).toBe(`http://127.0.0.1:${port}`);
      expect(app.tailscale.calls).toContainEqual(["serve", "--bg", "--yes", "--https=443", `http://127.0.0.1:${port}`]);
      // Never Funnel.
      expect(app.tailscale.calls.flat()).not.toContain("funnel");
      const pairing = await app.invoke<RemoteAccessPairing>(WISP_IPC_CHANNELS.pairRemoteDevice);
      expect(pairing.link).toBe(`${origin}/#pair=${pairing.code}`);

      await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, {
        enabled: false,
        port,
        automatic: true,
        publicOrigin: origin,
      });
      expect(app.tailscale.handler).toBeUndefined();
      // The switch turns it on again the same way.
      await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, {
        enabled: true,
        port,
        automatic: true,
        publicOrigin: origin,
      });
      expect(app.tailscale.handler).toBe(`http://127.0.0.1:${port}`);

      // A new port moves the serve Wisp added.
      const next = await freePort();
      await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port: next, automatic: true });
      expect(app.tailscale.handler).toBe(`http://127.0.0.1:${next}`);
      expect(await answers(next)).toBe(true);
      expect(await answers(port)).toBe(false);
    });

    it("never replaces a serve it did not add, nor removes one", async () => {
      const app = await desktop();
      await app.waitForPhase("local");
      const port = await freePort();
      app.tailscale.handler = "http://127.0.0.1:3000";
      expect(
        await app.call(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, automatic: true }),
      ).toMatchObject({ ok: false, error: { message: expect.stringContaining("already shares something else") } });
      expect(app.tailscale.handler).toBe("http://127.0.0.1:3000");
      expect(await app.invoke(WISP_IPC_CHANNELS.getRemoteAccess)).toMatchObject({ enabled: false });

      // Set up by hand for Wisp's port: used as it is, and left in place when turned off.
      app.tailscale.serveByHand(port);
      await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, automatic: true });
      await app.invoke(WISP_IPC_CHANNELS.saveRemoteAccess, {
        enabled: false,
        port,
        automatic: true,
        publicOrigin: origin,
      });
      expect(app.tailscale.handler).toBe(`http://127.0.0.1:${port}`);
    });

    it("says what to do when Tailscale cannot serve this computer, and changes nothing", async () => {
      const app = await desktop();
      await app.waitForPhase("local");
      const port = await freePort();
      const turnOn = () => app.call(WISP_IPC_CHANNELS.saveRemoteAccess, { enabled: true, port, automatic: true });

      app.tailscale.needsConsent = true;
      app.tailscale.httpsEnabled = false;
      expect((await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.getRemoteAccess)).tailscale).toEqual({
        status: "ready",
        origin,
        httpsEnabled: false,
      });
      expect(await turnOn()).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("https://login.tailscale.com/f/serve?node=n123") },
      });
      app.tailscale.needsConsent = false;

      app.tailscale.denied = true;
      expect(await turnOn()).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("sudo tailscale set --operator=$USER") },
      });
      app.tailscale.denied = false;

      app.tailscale.running = false;
      expect((await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.getRemoteAccess)).tailscale).toMatchObject({
        status: "not_running",
      });
      expect(await turnOn()).toMatchObject({ ok: false, error: { message: expect.stringContaining("not running") } });

      app.tailscale.installed = false;
      expect((await app.invoke<RemoteAccessView>(WISP_IPC_CHANNELS.getRemoteAccess)).tailscale).toMatchObject({
        status: "not_installed",
      });
      expect(await turnOn()).toMatchObject({ ok: false, error: { message: expect.stringContaining("not installed") } });

      expect(app.tailscale.handler).toBeUndefined();
      expect(await answers(port)).toBe(false);
      await expect(readFile(path.join(app.directory, "remote-access.json"))).rejects.toThrow();
    });
  });
});
