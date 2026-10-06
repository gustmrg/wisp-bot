import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { MasterKeyEncryption } from "../../server/master-key.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "wisp-key-"));
  directories.push(created);
  return created;
}

describe("MasterKeyEncryption", () => {
  it("round-trips values and authenticates them", () => {
    const encryption = new MasterKeyEncryption(randomBytes(32));
    const sealed = encryption.encrypt("sk-secret");
    expect(sealed.toString("utf8")).not.toContain("sk-secret");
    expect(encryption.decrypt(sealed)).toBe("sk-secret");
    const envelope = JSON.parse(sealed.toString("utf8"));
    envelope.payload = Buffer.from("tampered").toString("base64");
    expect(() => encryption.decrypt(Buffer.from(JSON.stringify(envelope)))).toThrow();
  });

  it("rejects ciphertext from another key and refuses to store without one", () => {
    const sealed = new MasterKeyEncryption(randomBytes(32)).encrypt("value");
    expect(() => new MasterKeyEncryption(randomBytes(32)).decrypt(sealed)).toThrow(/different master key/);
    const missing = MasterKeyEncryption.fromFile(undefined);
    expect(missing.isAvailable()).toBe(false);
    expect(() => missing.encrypt("value")).toThrow(expect.objectContaining({ code: "secure_storage_unavailable" }));
  });

  it("generates private key files and refuses readable or short ones", async () => {
    const root = await directory();
    const file = path.join(root, "master.key");
    MasterKeyEncryption.generate(file);
    expect(MasterKeyEncryption.fromFile(file).isAvailable()).toBe(true);
    expect(() => MasterKeyEncryption.generate(file)).toThrow();
    await chmod(file, 0o644);
    expect(() => MasterKeyEncryption.fromFile(file)).toThrow(/readable only by its owner/);
    const short = path.join(root, "short.key");
    await writeFile(short, randomBytes(16), { mode: 0o600 });
    expect(() => MasterKeyEncryption.fromFile(short)).toThrow(/32 bytes/);
  });
});
