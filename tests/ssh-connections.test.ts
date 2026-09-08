import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionProfileStore, validateConnectionProfile } from "../electron/connections/profile-store.js";
import {
  buildSshArguments,
  classifySshFailure,
  tailscaleAuthenticationUrl,
} from "../electron/connections/ssh-tunnel.js";
import type { SshConnectionProfile } from "../shared/connections.js";

const profile: SshConnectionProfile = {
  id: "server",
  name: "Wisp server",
  kind: "ssh",
  host: "wisp.my-tailnet.ts.net",
  username: "wisp",
  port: 22,
  remotePort: 8787,
  sshAuthMode: "openssh",
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
describe("SSH transport boundaries", () => {
  it("uses strict host validation and loopback forwarding with a closed administrative command", () => {
    const args = buildSshArguments(profile, "/tmp/Wisp data/known_hosts", 12345);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("PermitLocalCommand=no");
    expect(args).toContain("127.0.0.1:12345:127.0.0.1:8787");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(profile.host);
    expect(buildSshArguments(profile, "/tmp/known_hosts", undefined, true).at(-1)).toBe("wispctl pair --json");
  });
  it("accepts MagicDNS, IPv4, IPv6 and user-defined SSH aliases", () => {
    for (const host of ["wisp", "100.100.12.4", "fd7a:115c:a1e0::1", "server_alias"])
      expect(validateConnectionProfile({ ...profile, host })).toMatchObject({ host });
  });
  it("rejects option and shell injection, invalid ports and relative key paths", () => {
    for (const host of ["-oProxyCommand=bad", "host;id", "host\nProxyCommand bad", "user@host", "$(whoami)"])
      expect(() => validateConnectionProfile({ ...profile, host })).toThrow();
    for (const port of [-1, 0, 65536, 22.5, "22"])
      expect(() => validateConnectionProfile({ ...profile, port })).toThrow();
    expect(() => validateConnectionProfile({ ...profile, username: "-oBad" })).toThrow();
    expect(() => validateConnectionProfile({ ...profile, identityFile: "../id_rsa" })).toThrow();
    expect(() => buildSshArguments(profile, "/tmp/x\nProxyCommand=bad", 123)).toThrow();
  });
  it("keeps changed host keys distinct from unknown keys and authentication failures", () => {
    expect(classifySshFailure("REMOTE HOST IDENTIFICATION HAS CHANGED!").code).toBe("host_changed");
    expect(classifySshFailure("No ED25519 host key is known for host").code).toBe("host_unknown");
    expect(classifySshFailure("Permission denied (publickey)").code).toBe("authentication");
  });
  it("allows only the official HTTPS Tailscale authentication host", () => {
    expect(tailscaleAuthenticationUrl("Check https://login.tailscale.com/a/abc to authenticate")).toBe(
      "https://login.tailscale.com/a/abc",
    );
    for (const url of [
      "http://login.tailscale.com/a/b",
      "https://login.tailscale.com.evil/a/b",
      "https://user:pass@login.tailscale.com/a/b",
      "https://login.tailscale.com:8443/a/b",
      "file:///tmp/evil",
    ])
      expect(tailscaleAuthenticationUrl(url)).toBeUndefined();
    expect(() => validateConnectionProfile({ ...profile, sshAuthMode: "tailscale-ssh", port: 2222 })).toThrow();
  });
});
describe("connection profiles", () => {
  const encryption = {
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(value).map((byte) => byte ^ 0x55),
    decrypt: (value: Buffer) =>
      Buffer.from(value)
        .map((byte) => byte ^ 0x55)
        .toString(),
  };
  it("encrypts credentials and discards them when a profile destination changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-profiles-"));
    directories.push(directory);
    const store = new ConnectionProfileStore(directory, encryption);
    await store.load();
    await store.save(profile);
    const credentials = {
      accessToken: "access-should-not-appear",
      refreshToken: "refresh-should-not-appear",
      serverId: "server-id",
      deviceId: "device",
      expiresAt: new Date().toISOString(),
    };
    await store.saveCredentials(profile.id, credentials);
    const file = await readFile(path.join(directory, "connections.json"), "utf8");
    expect(file).not.toContain(credentials.accessToken);
    expect(file).not.toContain(credentials.refreshToken);
    const reloaded = new ConnectionProfileStore(directory, encryption);
    await reloaded.load();
    expect(await reloaded.credentials(profile.id)).toEqual(credentials);
    await reloaded.save({ ...profile, host: "another-server", expectedServerId: "server-id" });
    expect(await reloaded.credentials(profile.id)).toBeUndefined();
    expect(reloaded.get(profile.id).expectedServerId).toBeUndefined();
  });
  it("never falls back to plaintext when secure storage is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-profiles-"));
    directories.push(directory);
    const store = new ConnectionProfileStore(directory, { ...encryption, isAvailable: () => false });
    await store.load();
    await expect(
      store.saveCredentials("server", {
        accessToken: "a",
        refreshToken: "b",
        serverId: "c",
        deviceId: "d",
        expiresAt: "now",
      }),
    ).rejects.toThrow("Secure storage");
  });
});
