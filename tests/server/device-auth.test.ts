import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeviceAuth } from "../../server/device-auth.js";
import { HttpError } from "../../server/errors.js";
import { ServerStore } from "../../server/server-store.js";

const stores: ServerStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-auth-"));
  directories.push(directory);
  let now = Date.parse("2026-10-05T12:00:00.000Z");
  const store = new ServerStore(directory);
  stores.push(store);
  return {
    directory,
    store,
    auth: new DeviceAuth(store, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function status(operation: () => unknown): number | undefined {
  try {
    operation();
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return undefined;
}

describe("DeviceAuth", () => {
  it("pairs once per code, accepting the code without its dash or case", async () => {
    const { auth, store } = await setup();
    const { code } = auth.createPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const credentials = auth.pair(code.replace("-", "").toLowerCase(), "Laptop");
    expect(credentials.serverId).toBe(store.serverId);
    expect(auth.authenticate(credentials.accessToken)).toBe(credentials.deviceId);
    expect(status(() => auth.pair(code, "Again"))).toBe(401);
    expect(auth.devices()).toEqual([expect.objectContaining({ id: credentials.deviceId, name: "Laptop" })]);
  });

  it("expires pairing codes and access tokens", async () => {
    const { auth, advance } = await setup();
    const expired = auth.createPairingCode().code;
    advance(10 * 60_000);
    expect(status(() => auth.pair(expired, "Late"))).toBe(401);
    const credentials = auth.pair(auth.createPairingCode().code, "Laptop");
    advance(15 * 60_000);
    expect(status(() => auth.authenticate(credentials.accessToken))).toBe(401);
    expect(auth.authenticate(auth.refresh(credentials.refreshToken).accessToken)).toBe(credentials.deviceId);
  });

  it("rate-limits failed pairing attempts", async () => {
    const { auth, advance } = await setup();
    for (let attempt = 0; attempt < 10; attempt++) expect(status(() => auth.pair("WRONG-CODES", "x"))).toBe(401);
    const { code } = auth.createPairingCode();
    expect(status(() => auth.pair(code, "Blocked"))).toBe(429);
    advance(60_001);
    expect(auth.pair(code, "Allowed").deviceId).toBeTruthy();
  });

  it("rotates refresh tokens and lets a lost response be retried briefly", async () => {
    const { auth, advance } = await setup();
    const first = auth.pair(auth.createPairingCode().code, "Phone");
    const second = auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // The response carrying `second` was lost; the client retries with the old token.
    const retried = auth.refresh(first.refreshToken);
    expect(auth.authenticate(retried.accessToken)).toBe(first.deviceId);
    advance(60_001);
    expect(status(() => auth.refresh(first.refreshToken))).toBe(401);
    expect(auth.refresh(retried.refreshToken).deviceId).toBe(first.deviceId);
  });

  it("keeps devices across restarts but requires a refresh for access", async () => {
    const { auth, directory, store } = await setup();
    const credentials = auth.pair(auth.createPairingCode().code, "Desktop");
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new ServerStore(directory);
    stores.push(reopened);
    expect(reopened.serverId).toBe(store.serverId);
    const restarted = new DeviceAuth(reopened);
    expect(status(() => restarted.authenticate(credentials.accessToken))).toBe(401);
    expect(restarted.refresh(credentials.refreshToken).deviceId).toBe(credentials.deviceId);
  });

  it("revokes a device's tokens and notifies listeners", async () => {
    const { auth } = await setup();
    const credentials = auth.pair(auth.createPairingCode().code, "Tablet");
    const revoked: string[] = [];
    auth.onRevoke((id) => revoked.push(id));
    expect(auth.revoke(credentials.deviceId)).toBe(true);
    expect(revoked).toEqual([credentials.deviceId]);
    expect(status(() => auth.authenticate(credentials.accessToken))).toBe(401);
    expect(status(() => auth.refresh(credentials.refreshToken))).toBe(401);
    expect(auth.revoke(credentials.deviceId)).toBe(false);
    expect(auth.devices()).toEqual([]);
  });
});
