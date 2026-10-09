import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { FatalTransportError } from "../../client/remote-session.js";
import { questionKind, SshAskpass } from "../../electron/connections/ssh-askpass.js";
import {
  describeKey,
  findPublicKeys,
  publicKeyLine,
  type SshInteraction,
} from "../../electron/connections/ssh-auth.js";
import {
  AUTHORIZE_COMMAND,
  classify,
  explainPairingFailure,
  openSshTunnel,
  sshArguments,
} from "../../electron/connections/ssh-tunnel.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer } from "../../server/wisp-server.js";
import type { SshConnectionProfile, SshPromptView } from "../../shared/connections.js";

const TEST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3Q= wisp@laptop";
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-ssh-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Answers SSH's questions from `answers`, in order, and records what was asked. */
async function interaction(answers: Array<string | undefined>, keys = [TEST_KEY]) {
  const askpass = await SshAskpass.start();
  cleanups.push(() => askpass.close());
  const asked: Array<Omit<SshPromptView, "id">> = [];
  const value: SshInteraction = {
    askpass,
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift();
    },
    publicKeys: async () => keys,
  };
  return { value, asked };
}

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
      ["denied", /did not accept an SSH key from this computer/],
      ["changed", /host key of home-server has changed.*ssh-keygen -R home-server/],
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
    const pi = { ...profile(8787), host: "pi" };
    expect(explainPairingFailure(pi, 255, "user@pi: Permission denied (publickey).", false).message).toMatch(
      /user@pi did not accept an SSH key/,
    );
    expect(
      explainPairingFailure(pi, 127, "/home/u/.local/bin/wispctl: 4: exec: node: not found", false).message,
    ).toMatch(/Node.js is missing on pi/);
    expect(
      explainPairingFailure(pi, 1, "Error: Cannot find module '/home/u/.local/lib/wisp/server/cli.js'", false).message,
    ).toMatch(/server files are missing on pi/);
    expect(explainPairingFailure(pi, null, "", true).message).toMatch(/did not answer within 30 seconds/);
    expect(explainPairingFailure(pi, 1, "something odd\n", false).message).toMatch(
      /Could not get a pairing code from pi\. Or run `wispctl pair` there and enter the code here\. \(something odd\)/,
    );
  });

  it("says which user the server turned away, and how to authorize this computer's key", () => {
    const message = classify(
      "gustavo@home-server: Permission denied (publickey,password).\n",
      profile(1),
      undefined,
    ).message;
    // The user OpenSSH used, which ~/.ssh/config may set, wins over the profile's.
    expect(message).toContain("gustavo@home-server did not accept an SSH key from this computer.");
    expect(message).toMatch(/terminal may ask for a password, but Wisp cannot ask here/);
    expect(message).toContain("authorized_keys for gustavo on home-server");
    expect(message).toContain("`ssh-copy-id -p 2222 gustavo@home-server`");
    expect(message).toContain("`ssh -o BatchMode=yes -p 2222 gustavo@home-server true`");

    const keysOnly = classify("Permission denied (publickey).", { ...profile(1), sshPort: undefined }, undefined);
    expect(keysOnly).toBeInstanceOf(FatalTransportError);
    expect(keysOnly.message).not.toMatch(/password/);
    expect(keysOnly.message).toContain("`ssh-copy-id wisp@home-server`");
  });

  it("asks to trust a new host key through askpass, then remembers it", async () => {
    const { instance, directory } = await server();
    process.env.FAKE_SSH_ASK = "hostkey";
    process.env.FAKE_SSH_KNOWN = path.join(directory, "known_hosts");
    process.env.FAKE_SSH_LOG = path.join(directory, "ssh.log");
    const { value, asked } = await interaction(["yes"]);
    const tunnel = await openSshTunnel(profile(instance.port), { sshPath: fakeSsh, interaction: value });
    cleanups.push(() => tunnel.close());
    expect(asked).toEqual([expect.objectContaining({ kind: "host_key", host: "home-server" })]);
    expect(asked[0]?.message).toMatch(/ED25519 key fingerprint is SHA256:fakefakefake/);
    // Without BatchMode, so OpenSSH can ask.
    expect(await readFile(process.env.FAKE_SSH_LOG, "utf8")).not.toContain("BatchMode=yes");

    const again = await openSshTunnel(profile(instance.port), { sshPath: fakeSsh, interaction: value });
    cleanups.push(() => again.close());
    expect(asked).toHaveLength(1);
  });

  it("uses a password once to add this computer's key", async () => {
    const { instance, directory } = await server();
    process.env.FAKE_WISP_DATA_DIR = directory;
    process.env.FAKE_SSH_ASK = "password";
    process.env.FAKE_SSH_AUTHORIZED = path.join(directory, "authorized_keys");
    const { value, asked } = await interaction(["nope", "hunter2"]);
    const tunnel = await openSshTunnel(profile(instance.port), { sshPath: fakeSsh, interaction: value });
    cleanups.push(() => tunnel.close());
    expect(asked).toEqual([
      expect.objectContaining({ kind: "password", keys: [describeKey(TEST_KEY)] }),
      expect.objectContaining({ kind: "password", retry: true }),
    ]);
    expect(await readFile(process.env.FAKE_SSH_AUTHORIZED, "utf8")).toBe(`${TEST_KEY}\n`);
    // The key works now: pairing asks nothing.
    expect(await tunnel.requestPairingCode?.()).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(asked).toHaveLength(2);
  });

  it("explains a password that was not accepted, or that has no key to authorize", async () => {
    const directory = await temporaryDirectory();
    process.env.FAKE_SSH_ASK = "password";
    process.env.FAKE_SSH_AUTHORIZED = path.join(directory, "authorized_keys");
    const wrong = await interaction(["a", "b", "c"]);
    const failure = openSshTunnel(profile(1), { sshPath: fakeSsh, interaction: wrong.value });
    await expect(failure).rejects.toBeInstanceOf(FatalTransportError);
    await expect(failure).rejects.toThrow(/wisp@home-server did not accept the password/);
    expect(wrong.asked).toHaveLength(3);

    const keyless = await interaction(["hunter2"], []);
    await expect(openSshTunnel(profile(1), { sshPath: fakeSsh, interaction: keyless.value })).rejects.toThrow(
      /this computer has no SSH key yet\. Create one with `ssh-keygen -t ed25519`/,
    );
    expect(keyless.asked).toEqual([]);
  });

  it("asks for the passphrase of a key", async () => {
    const { instance } = await server();
    process.env.FAKE_SSH_ASK = "passphrase";
    const { value, asked } = await interaction(["open sesame"]);
    const tunnel = await openSshTunnel(profile(instance.port), { sshPath: fakeSsh, interaction: value });
    cleanups.push(() => tunnel.close());
    expect(asked).toEqual([expect.objectContaining({ kind: "passphrase" })]);
  });

  it("adds keys to authorized_keys once each, keeping what is there", async () => {
    const home = await temporaryDirectory();
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = execFile(
          "sh",
          ["-c", AUTHORIZE_COMMAND],
          { env: { PATH: process.env.PATH, HOME: home } },
          (error) => (error ? reject(error) : resolve()),
        );
        child.stdin?.end(`${TEST_KEY}\n`);
      });
    await run();
    const file = path.join(home, ".ssh", "authorized_keys");
    expect(await readFile(file, "utf8")).toBe(`${TEST_KEY}\n`);
    expect((await stat(path.join(home, ".ssh"))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // A last line without a newline is kept whole, and a key already there is not added again.
    await writeFile(file, "ssh-rsa AAAA old");
    await run();
    await run();
    expect(await readFile(file, "utf8")).toBe(`ssh-rsa AAAA old\n${TEST_KEY}\n`);
  });

  it("adds only the key OpenSSH would use for the host", async () => {
    const directory = await temporaryDirectory();
    process.env.FAKE_SSH_IDENTITY = path.join(directory, "pi_key");
    await writeFile(path.join(directory, "pi_key.pub"), `${TEST_KEY}\n`);
    expect(await findPublicKeys(fakeSsh, profile(1))).toEqual([TEST_KEY]);
  });

  it("only adds plain public keys, and tells questions apart", () => {
    expect(publicKeyLine(`${TEST_KEY}\r`)).toBe(TEST_KEY);
    expect(publicKeyLine('command="rm -rf ~" ssh-ed25519 AAAA x')).toBeUndefined();
    expect(publicKeyLine("ssh-ed25519 AAAA$(reboot)")).toBeUndefined();
    expect(publicKeyLine("ssh-ed25519 AAAA me\u0007@host")).toBe("ssh-ed25519 AAAA me@host");
    expect(describeKey("ssh-ed25519 AAAA")).toMatch(/^ssh-ed25519 \(SHA256:[A-Za-z0-9+/]+\)$/);

    expect(questionKind("Are you sure you want to continue connecting (yes/no/[fingerprint])?", "")).toBe("host_key");
    expect(questionKind("gustavo@pi's password:", "")).toBe("password");
    expect(questionKind("(gustavo@mac) Password:", "")).toBe("password");
    expect(questionKind("Enter passphrase for key '/u/.ssh/id_ed25519':", "")).toBe("passphrase");
    expect(questionKind("Allow use of key?", "confirm")).toBe("confirm");
    expect(questionKind("Verification code:", "")).toBe("secret");
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
