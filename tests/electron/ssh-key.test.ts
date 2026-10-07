import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describePrompt } from "../../electron/connections/ssh-askpass.js";
import { authorizeKeyCommand } from "../../electron/connections/ssh-check.js";
import { sanitizeComment, WispSshKey } from "../../electron/connections/ssh-key.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe("Wisp's SSH key", () => {
  it("creates an ed25519 key once, private to this user", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-key-"));
    directories.push(directory);
    const key = new WispSshKey(path.join(directory, "ssh", "wisp_ed25519"));
    expect(key.identityFile).toBeUndefined();
    const publicKey = await key.publicKey("Gustavo's laptop");
    expect(publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ wisp@Gustavo-s-laptop$/);
    expect(key.identityFile).toBe(path.join(directory, "ssh", "wisp_ed25519"));
    expect((await stat(key.file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(key.file))).mode & 0o777).toBe(0o700);
    // Asking again keeps the key a server may already trust.
    expect(await key.publicKey("Another name")).toBe(publicKey);
    expect(await readFile(key.file, "utf8")).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  });

  it.runIf(hasSshKeygen)("writes a private key OpenSSH reads", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-key-"));
    directories.push(directory);
    const key = new WispSshKey(path.join(directory, "wisp_ed25519"));
    const publicKey = await key.publicKey("test");
    const derived = spawnSync("ssh-keygen", ["-y", "-f", key.file], { encoding: "utf8" });
    expect(derived.status).toBe(0);
    expect(derived.stdout.trim()).toBe(publicKey);
  });

  it("keeps comments and commands safe for the remote shell", () => {
    expect(sanitizeComment("a b'c;$(x)")).toBe("wisp@a-b-c-x");
    expect(sanitizeComment("'")).toBe("wisp@desktop");
    expect(authorizeKeyCommand("ssh-ed25519 AAAA+/= wisp@box")).toContain(
      `printf '%s\\n' 'restrict,port-forwarding ssh-ed25519 AAAA+/= wisp@box'`,
    );
    expect(() => authorizeKeyCommand("ssh-ed25519 AAAA wisp@x'; rm -rf ~")).toThrow(/invalid/);
  });
});

describe("OpenSSH questions", () => {
  it("tells host keys, secrets, and confirmations apart", () => {
    expect(
      describePrompt(
        "The authenticity of host 'pi (100.64.0.1)' can't be established.\nED25519 key fingerprint is SHA256:abc+/1=.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
      ),
    ).toEqual({
      kind: "hostKey",
      host: "pi (100.64.0.1)",
      keyType: "ED25519",
      fingerprint: "SHA256:abc+/1=",
      message: expect.stringContaining("authenticity of host"),
    });
    expect(describePrompt("me@pi's password: ")).toEqual({ kind: "secret", message: "me@pi's password:" });
    expect(describePrompt("Allow use of key id_ed25519?", "confirm")).toEqual({
      kind: "confirm",
      message: "Allow use of key id_ed25519?",
    });
  });
});
