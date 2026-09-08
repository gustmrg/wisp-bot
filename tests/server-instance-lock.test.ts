import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ServerDatabase } from "../server/storage/database.js";

const directories: string[] = [];
const databases: ServerDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "wisp-instance-lock-"));
  directories.push(value);
  return value;
}

describe("OS-owned server instance lock", { timeout: 15000 }, () => {
  it("ignores a reused live PID in the old diagnostic file while still excluding another live instance", async () => {
    const root = await directory();
    await writeFile(path.join(root, "server.lock"), JSON.stringify({ pid: process.pid, nonce: "old-container" }));
    await writeFile(path.join(root, "server.lock.recovery"), "legacy interrupted PID recovery");
    const database = new ServerDatabase(root);
    databases.push(database);
    expect(database.serverId).toBeTypeOf("string");
    expect(() => new ServerDatabase(root)).toThrow("Another server owns");
  });

  it("excludes a separate lock owner and recovers immediately after SIGKILL, regardless of diagnostic PID reuse", async () => {
    const root = await directory();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require("node:sqlite");
      const path = require("node:path");
      const guard = new DatabaseSync(path.join(process.argv[1], "instance-lock.sqlite"));
      guard.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `,
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout, "data");
      expect(() => new ServerDatabase(root)).toThrow("Another server owns");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await writeFile(path.join(root, "server.lock"), JSON.stringify({ pid: process.pid, nonce: "reused-pid" }));
      const restarted = new ServerDatabase(root);
      databases.push(restarted);
      expect(restarted.serverId).toBeTypeOf("string");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("releases both databases after startup fails so a corrected instance can start", async () => {
    const root = await directory();
    const original = new ServerDatabase(root);
    original.setMeta("schemaVersion", "999");
    original.close();
    expect(() => new ServerDatabase(root)).toThrow("Unsupported server schema");
    const repair = new DatabaseSync(path.join(root, "wisp.sqlite"));
    repair.prepare("UPDATE metadata SET value='1' WHERE key='schemaVersion'").run();
    repair.close();
    const restarted = new ServerDatabase(root);
    databases.push(restarted);
    expect(restarted.getMeta("schemaVersion")).toBe("1");
  });
});
