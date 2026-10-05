import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

async function launcher(dataDirectory?: string, masterKey = randomBytes(32)) {
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

  it("stops when the app that started it goes away", async () => {
    const { server } = await launcher();
    const running = await server.ensureRunning();
    // Closing stdin is what happens when the app process dies.
    await server.stop();
    await running.exited;
    await expect(fetch(`${running.baseUrl}/health`)).rejects.toThrow();
  }, 60_000);
});
