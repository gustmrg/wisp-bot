import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EncryptionService } from "../../backend/encrypted-credential-store.js";
import { ConnectionStore, parseRemoteProfile } from "../../electron/connections/connection-store.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const encryption = (available = true): EncryptionService => ({
  isAvailable: () => available,
  encrypt: (value) => Buffer.from(`sealed:${value}`),
  decrypt: (value) => value.toString("utf8").replace(/^sealed:/, ""),
});

const credentials: DeviceCredentials = {
  deviceId: "device",
  serverId: "server",
  accessToken: "access",
  accessExpiresAt: "2026-10-05T12:15:00.000Z",
  refreshToken: "refresh-secret",
};

async function store(available = true, directory?: string) {
  const root = directory ?? (await mkdtemp(path.join(os.tmpdir(), "wisp-connections-")));
  if (!directory) directories.push(root);
  const instance = new ConnectionStore(root, encryption(available));
  await instance.load();
  return { root, instance };
}

describe("parseRemoteProfile", () => {
  it("accepts SSH hosts, aliases, and private HTTPS or loopback URLs", () => {
    expect(parseRemoteProfile({ kind: "ssh", name: " Home ", host: "raspberrypi", serverPort: 8787 }, "a")).toEqual({
      id: "a",
      kind: "ssh",
      name: "Home",
      host: "raspberrypi",
      serverPort: 8787,
    });
    expect(parseRemoteProfile({ kind: "url", name: "Tailnet", url: "https://pi.tail1234.ts.net/" }, "b")).toMatchObject(
      {
        url: "https://pi.tail1234.ts.net",
      },
    );
    expect(parseRemoteProfile({ kind: "url", name: "Dev", url: "http://127.0.0.1:8787" }, "c")).toMatchObject({
      url: "http://127.0.0.1:8787",
    });
  });

  it("rejects values that would become SSH options or leave the private network", () => {
    const ssh = { kind: "ssh", name: "x", host: "pi", serverPort: 8787 };
    for (const bad of [
      { ...ssh, host: "-oProxyCommand=evil" },
      { ...ssh, host: "pi; rm -rf ~" },
      { ...ssh, user: "-l" },
      { ...ssh, serverPort: 0 },
      { ...ssh, sshPort: 70000 },
      { kind: "url", name: "x", url: "http://example.com" },
      { kind: "url", name: "x", url: "https://user:pass@example.com" },
      { kind: "url", name: "x", url: "https://example.com/path" },
      { kind: "other", name: "x" },
    ]) {
      expect(() => parseRemoteProfile(bad, "id"), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("ConnectionStore", () => {
  it("persists profiles, the active choice, and encrypted credentials", async () => {
    const { root, instance } = await store();
    expect(instance.active.id).toBe("local");
    const profile = await instance.save({ kind: "ssh", name: "Home", host: "pi", serverPort: 8787 });
    await instance.setActive(profile.id);
    await instance.saveCredentials(profile.id, credentials);
    await instance.flush();
    expect(await readFile(path.join(root, "connection-credentials.json"), "utf8")).not.toContain("refresh-secret");

    const { instance: reloaded } = await store(true, root);
    expect(reloaded.active).toEqual(profile);
    expect(reloaded.loadCredentials(profile.id)).toEqual(credentials);
  });

  it("forgets credentials when a profile's address changes or it is removed", async () => {
    const { instance } = await store();
    const profile = await instance.save({ kind: "ssh", name: "Home", host: "pi", serverPort: 8787 });
    await instance.saveCredentials(profile.id, credentials);
    await instance.save({ ...profile, name: "Renamed" });
    expect(instance.loadCredentials(profile.id)).toEqual(credentials);
    await instance.save({ ...profile, host: "other-pi" });
    expect(instance.loadCredentials(profile.id)).toBeUndefined();
    await instance.setActive(profile.id);
    await instance.remove(profile.id);
    expect(instance.active.id).toBe("local");
    await expect(instance.save({ ...profile })).rejects.toThrow(/no longer exists/);
  });

  it("keeps credentials only in memory without secure storage", async () => {
    const { root, instance } = await store(false);
    const profile = await instance.save({ kind: "url", name: "Dev", url: "http://127.0.0.1:8787" });
    await instance.saveCredentials(profile.id, credentials);
    expect(instance.loadCredentials(profile.id)).toEqual(credentials);
    const { instance: reloaded } = await store(false, root);
    expect(reloaded.loadCredentials(profile.id)).toBeUndefined();
    expect(instance.secureStorageAvailable).toBe(false);
  });
});
