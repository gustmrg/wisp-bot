import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { FatalTransportError } from "../../client/remote-session.js";
import { explainPairingFailure, openSshTunnel, sshArguments } from "../../electron/connections/ssh-tunnel.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer } from "../../server/wisp-server.js";
import type { SshConnectionProfile } from "../../shared/connections.js";

const fakeSsh = path.join(__dirname, "../fixtures/fake-ssh.cjs");
const cleanups: Array<() => Promise<void> | void> = [];
const environment = { ...process.env };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  process.env = { ...environment };
});

const profile = (serverPort: number): SshConnectionProfile => ({
  id: "home",
  kind: "ssh",
  name: "Home",
  host: "home-server",
  user: "wisp",
  sshPort: 2222,
  serverPort,
});

async function server() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-ssh-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const instance = await createWispServer({
    dataDirectory: directory,
    host: "127.0.0.1",
    port: 0,
    encryption: new MasterKeyEncryption(randomBytes(32)),
    logger: new StructuredLogger({ info: () => undefined, warn: () => undefined }),
    agentMode: "fake",
    appVersion: "1.0.0",
    allowModelNetwork: false,
  });
  cleanups.push(() => instance.close());
  return { directory, instance };
}

describe("openSshTunnel", () => {
  it("forwards a free loopback port to the server and pairs through wispctl", async () => {
    const { directory, instance } = await server();
    const log = path.join(directory, "ssh.log");
    process.env.FAKE_WISP_DATA_DIR = directory;
    process.env.FAKE_SSH_LOG = log;
    const tunnel = await openSshTunnel(profile(instance.port), { sshPath: fakeSsh });
    cleanups.push(() => tunnel.close());
    expect(tunnel.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(tunnel.baseUrl).port).not.toBe(String(instance.port));
    expect((await fetch(`${tunnel.baseUrl}/health`)).status).toBe(200);
    expect(await tunnel.requestPairingCode?.()).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["-N", "-o", "BatchMode=yes", "-p", "2222", "-l", "wisp", "--", "home-server"]),
    );
    expect(calls[0]?.at(-1)).toBe("home-server");
    expect(calls[1]?.slice(-2)).toEqual(["home-server", 'PATH="$HOME/.local/bin:$PATH" wispctl pair --json']);

    tunnel.close();
    await tunnel.closed;
  });

  it("explains failures that retrying cannot fix", async () => {
    for (const [mode, message] of [
      ["hostkey", /host key of home-server is not trusted/],
      ["denied", /rejected this computer's SSH key/],
    ] as const) {
      process.env.FAKE_SSH_FAIL = mode;
      const failure = openSshTunnel(profile(1), { sshPath: fakeSsh });
      await expect(failure).rejects.toBeInstanceOf(FatalTransportError);
      await expect(failure).rejects.toThrow(message);
    }
    for (const [mode, message] of [
      ["resolve", /home-server could not be resolved/],
      ["refused", /home-server refused the SSH connection/],
    ] as const) {
      process.env.FAKE_SSH_FAIL = mode;
      const failure = openSshTunnel(profile(1), { sshPath: fakeSsh });
      await expect(failure).rejects.not.toBeInstanceOf(FatalTransportError);
      await expect(failure).rejects.toThrow(message);
    }
    await expect(openSshTunnel(profile(1), { sshPath: path.join(os.tmpdir(), "no-such-ssh") })).rejects.toThrow(
      /OpenSSH is not installed/,
    );
  });

  it("says what to fix on the server when pairing over SSH fails", async () => {
    const { directory, instance } = await server();
    process.env.FAKE_WISP_DATA_DIR = path.join(directory, "elsewhere");
    const tunnel = await openSshTunnel(profile(instance.port), { sshPath: fakeSsh });
    cleanups.push(() => tunnel.close());
    await expect(tunnel.requestPairingCode?.()).rejects.toThrow(/The Wisp server is not running on home-server/);

    process.env.FAKE_SSH_REMOTE = "missing";
    const missing = tunnel.requestPairingCode?.();
    await expect(missing).rejects.toBeInstanceOf(FatalTransportError);
    await expect(missing).rejects.toThrow(/wispctl is not installed on home-server.*enter the code here/);
  });

  it("explains a tunnel that reaches the host but no server", async () => {
    const { instance } = await server();
    const port = instance.port;
    await instance.close();
    const tunnel = await openSshTunnel(profile(port), { sshPath: fakeSsh });
    cleanups.push(() => tunnel.close());
    await expect(fetch(`${tunnel.baseUrl}/health`)).rejects.toThrow();
    await expect.poll(() => tunnel.explainFailure?.()).toMatch(/nothing answers on its port \d+/);
    // Explained once: a later failure needs its own report.
    expect(tunnel.explainFailure?.()).toBeUndefined();
  });

  it("maps pairing command failures to what to do", () => {
    expect(explainPairingFailure("pi", 255, "user@pi: Permission denied (publickey).", false).message).toMatch(
      /pi rejected this computer's SSH key/,
    );
    expect(
      explainPairingFailure("pi", 127, "/home/u/.local/bin/wispctl: 4: exec: node: not found", false).message,
    ).toMatch(/Node.js is missing on pi/);
    expect(
      explainPairingFailure("pi", 1, "Error: Cannot find module '/home/u/.local/lib/wisp/server/cli.js'", false)
        .message,
    ).toMatch(/server files are missing on pi/);
    expect(explainPairingFailure("pi", null, "", true).message).toMatch(/did not answer within 30 seconds/);
    expect(explainPairingFailure("pi", 1, "something odd\n", false).message).toMatch(
      /Could not get a pairing code from pi\. Or run `wispctl pair` there and enter the code here\. \(something odd\)/,
    );
  });

  it("never passes options from profile fields", () => {
    expect(sshArguments({ ...profile(8787), sshPort: undefined, user: undefined })).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
    ]);
  });
});
