import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sshTestFailure, testSshConnection } from "../../electron/connections/ssh-test.js";
import type { SshConnectionProfile } from "../../shared/connections.js";

const profile: SshConnectionProfile = {
  id: "test",
  kind: "ssh",
  name: "Unsaved",
  host: "private-host",
  user: "private-user",
  sshPort: 2222,
  serverPort: 8787,
};
const sshPath = path.join(__dirname, "../fixtures/fake-ssh.cjs");
const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

describe("SSH connection test", () => {
  it("authenticates without a Wisp server and allows retry after failure", async () => {
    process.env.FAKE_SSH_FAIL = "denied";
    await expect(testSshConnection(profile, { sshPath })).rejects.toThrow("authentication failed");
    delete process.env.FAKE_SSH_FAIL;
    await expect(testSshConnection(profile, { sshPath })).resolves.toMatchObject({
      message: expect.stringContaining("successful"),
    });
  });
  it("never includes raw stderr or profile details in failures", async () => {
    process.env.FAKE_SSH_TEST = "secret";
    await expect(testSshConnection(profile, { sshPath })).rejects.toThrow(sshTestFailure(""));
  });
  it("bounds the test and supports shutdown cancellation", async () => {
    process.env.FAKE_SSH_TEST = "hang";
    await expect(testSshConnection(profile, { sshPath, timeoutMs: 100 })).rejects.toThrow("timed out");
    const controller = new AbortController();
    const result = testSshConnection(profile, { sshPath, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
  });
  it("explains a missing client", async () => {
    await expect(testSshConnection(profile, { sshPath: "/no-such-ssh" })).rejects.toThrow("OpenSSH is not installed");
  });
  it.each([
    ["Permission denied (publickey)", "authentication failed"],
    ["Host key verification failed", "host key is not trusted yet"],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", "host key has changed"],
    ["Permission denied (publickey,password)", "takes a password"],
    ["Could not resolve hostname", "could not be resolved"],
    ["Connection refused", "connection was refused"],
    ["Network is unreachable", "could not be reached"],
    ["Connection timed out", "could not be reached"],
    ["tailscale approval", "requires approval"],
  ])("explains %s without returning raw details", (detail, expected) => {
    const result = sshTestFailure(`${detail} private-secret`);
    expect(result).toContain(expected);
    expect(result).not.toContain("private-secret");
  });
});
