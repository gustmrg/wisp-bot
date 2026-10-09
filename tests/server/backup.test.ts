import { createCipheriv, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { adminRequest } from "../../server/admin.js";
import { createBackup, restoreBackup, verifyBackup } from "../../server/backup.js";
import { runCli } from "../../server/cli.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";
import type { BackendResult } from "../../shared/contracts.js";
import type { Wisp } from "../../shared/conversations.js";
import type { DeviceCredentials } from "../../shared/remote-protocol.js";
import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const atlas: Wisp = { id: "atlas", name: "Atlas", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE };

async function start(dataDirectory: string, masterKey: Buffer, options: { adminSocket?: boolean } = {}) {
  const server = await createWispServer({
    dataDirectory,
    host: "127.0.0.1",
    port: 0,
    encryption: new MasterKeyEncryption(masterKey),
    logger: silent,
    agentMode: "fake",
    appVersion: "1.2.3",
    allowModelNetwork: false,
    ...options,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  cleanups.push(close);
  return { server, close };
}

async function post(server: WispServer, route: string, body: unknown, token?: string) {
  const response = await fetch(`${server.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { value: unknown } & BackendResult<unknown> };
}

async function pair(server: WispServer, dataDirectory: string): Promise<DeviceCredentials> {
  const { code } = (await adminRequest(dataDirectory, { command: "pair" })) as { code: string };
  return (await post(server, "/api/v1/auth/pair", { code, deviceName: "Laptop" })).body.value as DeviceCredentials;
}

async function keyFile(directory: string): Promise<{ file: string; key: Buffer }> {
  const file = path.join(directory, "backup.key");
  MasterKeyEncryption.generate(file);
  return { file, key: await readFile(file) };
}

/** A server data directory with a Wisp, a saved API key, workspace files, and things a backup leaves out. */
async function populated() {
  const dataDirectory = path.join(await temporary("wisp-source-"), "data");
  const masterKey = randomBytes(32);
  const { server, close } = await start(dataDirectory, masterKey);
  const credentials = await pair(server, dataDirectory);
  const rpc = (operation: string, payload: unknown) =>
    post(server, `/api/v1/rpc/${operation}`, payload, credentials.accessToken);
  await rpc("saveAiSettings", {
    selection: { providerId: "openrouter", modelId: "openai/gpt-oss-120b" },
    apiKey: "sk-saved",
  });
  await rpc("createWisp", { wisp: atlas, notifyOnUpdatesEnabled: true });
  const workspaces = path.join(dataDirectory, "backend", "workspaces");
  const [wispWorkspace] = await readdir(workspaces);
  await writeFile(path.join(workspaces, wispWorkspace!, "notes.md"), "# Notes\n");
  await writeFile(path.join(workspaces, wispWorkspace!, "big.bin"), randomBytes(3 * 1024 * 1024));
  await symlink("/etc/passwd", path.join(workspaces, wispWorkspace!, "outside"));
  await mkdir(path.join(dataDirectory, "backend", "logs"), { recursive: true });
  await writeFile(path.join(dataDirectory, "backend", "logs", "backend.log"), "log line\n");
  const [wispConfig] = await readdir(path.join(dataDirectory, "backend", "pi-config"));
  const transcriptions = path.join(dataDirectory, "backend", "pi-config", wispConfig!, "transcription-cache");
  await mkdir(transcriptions, { recursive: true });
  await writeFile(path.join(transcriptions, "entry.json"), JSON.stringify({ text: "Scanned contract" }));
  return {
    dataDirectory,
    masterKey,
    server,
    close,
    credentials,
    wispWorkspace: wispWorkspace!,
    wispConfig: wispConfig!,
  };
}

describe("backups", () => {
  it("restores an environment into a new directory that a server opens with the same key", async () => {
    const source = await populated();
    await source.close();
    const keys = await keyFile(await temporary("wisp-keys-"));
    const output = path.join(await temporary("wisp-backups-"), "home.wispbak");

    const summary = await createBackup({
      dataDirectory: source.dataDirectory,
      output,
      key: keys.key,
      appVersion: "1.2.3",
    });
    expect(summary.manifest).toMatchObject({ format: 1, appVersion: "1.2.3", serverId: source.server.serverId });
    expect(summary.skipped).toEqual([`backend/workspaces/${source.wispWorkspace}/outside`]);
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
    const raw = await readFile(output);
    expect(raw.includes(Buffer.from("# Notes"))).toBe(false);
    expect(raw.includes(Buffer.from("Atlas"))).toBe(false);
    await expect(verifyBackup({ input: output, key: keys.key })).resolves.toMatchObject({ files: summary.files });

    const target = path.join(await temporary("wisp-restored-"), "data");
    await restoreBackup({ input: output, key: keys.key, target });
    const workspace = path.join(target, "backend", "workspaces", source.wispWorkspace);
    expect(await readFile(path.join(workspace, "notes.md"), "utf8")).toBe("# Notes\n");
    expect((await readFile(path.join(workspace, "big.bin"))).length).toBe(3 * 1024 * 1024);
    await expect(lstat(path.join(workspace, "outside"))).rejects.toThrow();
    await expect(lstat(path.join(target, "backend", "logs"))).rejects.toThrow();
    await expect(
      lstat(path.join(target, "backend", "pi-config", source.wispConfig, "transcription-cache")),
    ).rejects.toThrow();

    // Same identity, devices, conversations, and credentials, in a different directory.
    const { server } = await start(target, source.masterKey);
    expect(server.serverId).toBe(source.server.serverId);
    const refreshed = (await post(server, "/api/v1/auth/refresh", { refreshToken: source.credentials.refreshToken }))
      .body.value as DeviceCredentials;
    const state = await post(server, "/api/v1/rpc/getConversationState", {}, refreshed.accessToken);
    expect(Object.keys((state.body as { ok: true; value: { chats: object } }).value.chats)).toEqual(["atlas"]);
    const settings = (
      (await post(server, "/api/v1/rpc/getAiSettings", {}, refreshed.accessToken)).body as {
        ok: true;
        value: { providers: Array<{ id: string; credentialConfigured: boolean }> };
      }
    ).value;
    expect(settings.providers.find(({ id }) => id === "openrouter")?.credentialConfigured).toBe(true);
  });

  it("refuses a wrong key, a changed byte, a cut-off file, and a directory in use", async () => {
    const source = await populated();
    await source.close();
    const keys = await keyFile(await temporary("wisp-keys-"));
    const backups = await temporary("wisp-backups-");
    const output = path.join(backups, "home.wispbak");
    await createBackup({ dataDirectory: source.dataDirectory, output, key: keys.key, appVersion: "1" });
    await expect(
      createBackup({ dataDirectory: source.dataDirectory, output, key: keys.key, appVersion: "1" }),
    ).rejects.toThrow(/already exists/);

    await expect(verifyBackup({ input: output, key: randomBytes(32) })).rejects.toThrow(/cannot be read with this key/);
    const bytes = await readFile(output);
    const changed = Buffer.from(bytes);
    changed[Math.floor(changed.length / 2)] ^= 0xff;
    await writeFile(path.join(backups, "changed.wispbak"), changed);
    await expect(verifyBackup({ input: path.join(backups, "changed.wispbak"), key: keys.key })).rejects.toThrow(
      /cannot be read/,
    );
    await writeFile(path.join(backups, "cut.wispbak"), bytes.subarray(0, bytes.length - 100));
    const target = path.join(backups, "restored");
    await expect(restoreBackup({ input: path.join(backups, "cut.wispbak"), key: keys.key, target })).rejects.toThrow();
    // A failed restore leaves nothing behind.
    await expect(lstat(target)).rejects.toThrow();
    expect((await readdir(backups)).filter((name) => name.includes("restoring"))).toEqual([]);

    await expect(restoreBackup({ input: output, key: keys.key, target: source.dataDirectory })).rejects.toThrow(
      /not empty/,
    );
    await expect(
      verifyBackup({ input: path.join(source.dataDirectory, "server.sqlite"), key: keys.key }),
    ).rejects.toThrow(/not a Wisp backup/);
  });

  it("rejects archive paths that would leave the restored directory", async () => {
    const backups = await temporary("wisp-backups-");
    const key = randomBytes(32);
    for (const unsafe of ["../outside", "backend/../../outside", "/etc/passwd", "elsewhere/file", "backend\\x"]) {
      const input = path.join(backups, `${randomBytes(4).toString("hex")}.wispbak`);
      await writeFile(input, forgedArchive(key, unsafe));
      const target = path.join(backups, `target-${randomBytes(4).toString("hex")}`);
      await expect(restoreBackup({ input, key, target }), unsafe).rejects.toThrow(/unsafe path/);
      await expect(lstat(path.join(backups, "outside"))).rejects.toThrow();
    }
  });

  it("backs up a running server through wispctl, only when no Wisp is working", async () => {
    const source = await populated();
    const keys = await keyFile(await temporary("wisp-keys-"));
    const backups = await temporary("wisp-backups-");
    const output: string[] = [];
    const cli = (...args: string[]) =>
      runCli([...args, "--data-dir", source.dataDirectory, "--json"], (text) => output.push(text));

    await post(
      source.server,
      "/api/v1/rpc/sendMessage",
      { conversationId: "atlas", requestId: "r1", text: "Hi" },
      source.credentials.accessToken,
    );
    await expect(
      cli("backup", "--output", path.join(backups, "busy.wispbak"), "--key-file", keys.file),
    ).rejects.toThrow(/working/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await cli("backup", "--output", path.join(backups, "live.wispbak"), "--key-file", keys.file);
    expect(JSON.parse(output.pop()!)).toMatchObject({ manifest: { serverId: source.server.serverId } });
    await cli("verify", "--input", path.join(backups, "live.wispbak"), "--key-file", keys.file);
    expect(JSON.parse(output.pop()!)).toMatchObject({ files: expect.any(Number) });

    // Offline: the CLI backs up an idle directory itself, and restores into a new one.
    await source.close();
    await cli("backup", "--output", path.join(backups, "offline.wispbak"), "--key-file", keys.file);
    await cli(
      "restore",
      "--input",
      path.join(backups, "offline.wispbak"),
      "--key-file",
      keys.file,
      "--target",
      path.join(backups, "restored"),
    );
    expect(await readdir(path.join(backups, "restored"))).toEqual(expect.arrayContaining(["backend", "server.sqlite"]));
  });

  it("waits for the desktop app to quit before backing up its directory", async () => {
    const dataDirectory = path.join(await temporary("wisp-desktop-"), "data");
    // The desktop app runs its server without an admin socket.
    await start(dataDirectory, randomBytes(32), { adminSocket: false });
    const keys = await keyFile(await temporary("wisp-keys-"));
    await expect(
      runCli(
        [
          "backup",
          "--data-dir",
          dataDirectory,
          "--output",
          path.join(dataDirectory, "x.wispbak"),
          "--key-file",
          keys.file,
        ],
        () => undefined,
      ),
    ).rejects.toThrow(/Quit it, then back up again/);
  });
});

/** Builds an authentic archive whose single file entry has the given path. */
function forgedArchive(key: Buffer, entryPath: string): Buffer {
  const magic = Buffer.from("WISPBAK1");
  const nonce = randomBytes(12);
  const plain = Buffer.from(
    [
      JSON.stringify({ type: "manifest", format: 1, createdAt: "2026-10-05T00:00:00.000Z", appVersion: "1" }),
      JSON.stringify({ type: "file", path: entryPath, size: 2, mode: 0o600 }),
    ].join("\n") +
      "\nhi" +
      `${JSON.stringify({ type: "end", files: 1, bytes: 2 })}\n`,
  );
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(magic);
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([magic, nonce, body, cipher.getAuthTag()]);
}
