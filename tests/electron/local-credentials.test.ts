import { randomBytes } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EncryptionService } from "../../backend/encrypted-credential-store.js";
import { StructuredLogger } from "../../backend/structured-logger.js";
import {
  loadOrCreateLocalMasterKey,
  migrateKeychainCredentials,
} from "../../electron/local-server/local-credentials.js";
import { MasterKeyEncryption } from "../../server/master-key.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Stands in for safeStorage: reversible, and recognizably not the server's envelope. */
const keychain = (available = true): EncryptionService => ({
  isAvailable: () => available,
  encrypt: (value) => Buffer.from(`keychain:${Buffer.from(value).toString("hex")}`),
  decrypt: (value) => {
    const text = value.toString("utf8");
    // Like safeStorage, refuses ciphertext it did not produce.
    if (!text.startsWith("keychain:")) throw new Error("Error while decrypting the ciphertext provided.");
    return Buffer.from(text.slice("keychain:".length), "hex").toString("utf8");
  },
});

async function directory(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "wisp-local-credentials-"));
  directories.push(created);
  return created;
}

describe("local server credentials", () => {
  it("keeps one master key, sealed by the keychain", async () => {
    const root = await directory();
    const key = await loadOrCreateLocalMasterKey(root, keychain());
    expect(key).toHaveLength(32);
    expect(await loadOrCreateLocalMasterKey(root, keychain())).toEqual(key);
    expect(await readFile(path.join(root, "local-server-key.json"), "utf8")).not.toContain(key!.toString("base64"));
    expect(await loadOrCreateLocalMasterKey(root, keychain(false))).toBeUndefined();
  });

  it("starts over with a new key when the keychain cannot open the stored one", async () => {
    const root = await directory();
    const original = await loadOrCreateLocalMasterKey(root, keychain());
    // Another computer's keychain, as after restoring a backup there.
    const elsewhere: EncryptionService = {
      ...keychain(),
      decrypt: () => {
        throw new Error("Error while decrypting the ciphertext provided.");
      },
    };
    const replacement = await loadOrCreateLocalMasterKey(root, elsewhere);
    expect(replacement).toHaveLength(32);
    expect(replacement).not.toEqual(original);
    expect((await readdir(root)).some((name) => name.startsWith("local-server-key.json.unreadable-"))).toBe(true);
  });
});
