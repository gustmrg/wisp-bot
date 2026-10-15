import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { RemoteClient } from "../../client/remote-client.js";
import { ChildProcessLocalServer } from "../../electron/local-server/local-server.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";

const root = path.join(__dirname, "../..");
// Inside node_modules, so the compiled server resolves the app's dependencies.
const build = path.join(root, "node_modules", ".cache", `wisp-local-server-${process.pid}`);
const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const directories: string[] = [];

beforeAll(() => {
  execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.electron.json", "--outDir", build], {
    cwd: root,
  });
}, 60_000);

afterAll(async () => {
  await rm(build, { recursive: true, force: true });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function launcher(dataDirectory?: string, masterKey = randomBytes(32), webRoot?: string) {
  const directory = dataDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "wisp-child-")));
  if (!dataDirectory) directories.push(directory);
  return {
    directory,
    masterKey,
    server: new ChildProcessLocalServer({
      scriptPath: path.join(build, "server", "main.js"),
      dataDirectory: directory,
      agentMode: "fake",
      masterKey,
      ...(webRoot ? { webRoot } : {}),
      logger: silent,
      execPath: process.execPath,
    }),
  };
}

function client(baseUrl: string) {
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

describe("ChildProcessLocalServer", () => {
  it("runs the server as a child process that pairs this app and keeps credentials across restarts", async () => {
    const { server, directory, masterKey } = await launcher();
    const running = await server.ensureRunning();
    expect(await server.ensureRunning()).toBe(running);
    expect((await fetch(`${running.baseUrl}/health`)).status).toBe(200);

    const app = client(running.baseUrl);
    await app.pair(running.localPairingCode, "Test computer");
    expect(
      await app.call("saveAiSettings", {
        selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" },
        apiKey: "sk-test",
      }),
    ).toMatchObject({
      ok: true,
    });
    await server.stop();
    await running.exited;

    const { server: restarted } = await launcher(directory, masterKey);
    const again = await restarted.ensureRunning();
    expect(again.localPairingCode).not.toBe(running.localPairingCode);
    const next = client(again.baseUrl);
    await next.pair(again.localPairingCode, "Test computer");
    const settings = await next.call("getAiSettings", {});
    expect(settings).toMatchObject({ ok: true });
    const providers = (
      settings as { ok: true; value: { providers: Array<{ id: string; credentialConfigured: boolean }> } }
    ).value.providers;
    expect(providers.find((provider) => provider.id === "openrouter")?.credentialConfigured).toBe(true);
    await restarted.stop();
  }, 60_000);

  it("explains why it could not start", async () => {
    const first = await launcher();
    await first.server.ensureRunning();
    const second = await launcher(first.directory);
    await expect(second.server.ensureRunning()).rejects.toThrow(/already using this data directory/);
    await first.server.stop();
  }, 60_000);

  it("serves other devices on a fixed port while exposed, and pairs them through its stdin", async () => {
    const web = await mkdtemp(path.join(os.tmpdir(), "wisp-web-"));
    directories.push(web);
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>Wisp</title>");
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { server } = await launcher(undefined, undefined, web);
    await expect(server.admin({ command: "devices" })).rejects.toThrow(/not running/);
    const running = await server.ensureRunning();
    const app = client(running.baseUrl);
    await app.pair(running.localPairingCode, "Test computer");

    // Exposed while running: a second port, without restarting or dropping this app.
    await server.setExposure({ port, publicOrigin: "https://laptop.tailnet.ts.net" });
    const exposed = `http://127.0.0.1:${port}`;
    const page = await fetch(`${exposed}/`, { headers: { host: "laptop.tailnet.ts.net" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Wisp</title>");
    expect(await app.call("getAiSettings", {})).toMatchObject({ ok: true });

    const { code } = (await server.admin({ command: "pair" })) as { code: string };
    await client(exposed).pair(code, "Chrome on Android");
    expect(await server.admin({ command: "devices" })).toEqual([
      expect.objectContaining({ name: "Test computer", local: true }),
      expect.objectContaining({ name: "Chrome on Android", local: false }),
    ]);
    await expect(server.admin({ command: "revoke", deviceId: "missing" })).rejects.toThrow(/No paired device/);

    // Not exposed: the port closes, and this app keeps its connection.
    await server.setExposure(undefined);
    await expect(fetch(`${exposed}/health`)).rejects.toThrow();
    expect(await app.call("getAiSettings", {})).toMatchObject({ ok: true });
    expect((await fetch(`${running.baseUrl}/`)).status).toBe(404);

    // A restarted server is exposed again before it is used.
    await server.setExposure({ port, publicOrigin: "https://laptop.tailnet.ts.net" });
    await server.stop();
    await server.ensureRunning();
    expect((await fetch(`${exposed}/health`)).status).toBe(200);
    await server.stop();
  }, 60_000);

  it("stops when the app that started it goes away", async () => {
    const { server } = await launcher();
    const running = await server.ensureRunning();
    // Closing stdin is what happens when the app process dies.
    await server.stop();
    await running.exited;
    await expect(fetch(`${running.baseUrl}/health`)).rejects.toThrow();
  }, 60_000);
});
