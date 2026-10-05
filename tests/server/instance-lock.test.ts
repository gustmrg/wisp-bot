import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InstanceLock } from "../../server/instance-lock.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("InstanceLock", () => {
  it("lets one server own a data directory at a time", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-lock-"));
    directories.push(directory);
    const lock = InstanceLock.acquire(directory);
    expect(() => InstanceLock.acquire(directory)).toThrow(/already using this data directory/);
    lock.release();
    lock.release();
    InstanceLock.acquire(directory).release();
  });
});
