import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EncryptedCredentialStore, type EncryptionService } from "../backend/encrypted-credential-store.js";
import { WispBackendError } from "../backend/backend-error.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

class TestEncryption implements EncryptionService {
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  encrypt(value: string): Buffer {
    return Buffer.from([...value].reverse().join(""), "utf8");
  }

  decrypt(value: Buffer): string {
    return [...value.toString("utf8")].reverse().join("");
  }
}

async function createStore(encryption = new TestEncryption()): Promise<{
  filePath: string;
  store: EncryptedCredentialStore;
  encryption: TestEncryption;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-credentials-"));
  directories.push(directory);
  const filePath = path.join(directory, "credentials.enc.json");
  return { filePath, store: new EncryptedCredentialStore(filePath, encryption), encryption };
}

describe("EncryptedCredentialStore", () => {
  it("round-trips credentials without writing plaintext", async () => {
    const { filePath, store, encryption } = await createStore();
    await store.setApiKey("anthropic", "secret-test-key");

    await expect(store.read("anthropic")).resolves.toEqual({ type: "api_key", key: "secret-test-key" });
    await expect(store.list()).resolves.toEqual([{ providerId: "anthropic", type: "api_key" }]);
    expect(await readFile(filePath, "utf8")).not.toContain("secret-test-key");

    const reloaded = new EncryptedCredentialStore(filePath, encryption);
    await expect(reloaded.read("anthropic")).resolves.toEqual({ type: "api_key", key: "secret-test-key" });
  });

  it("serializes concurrent provider updates", async () => {
    const { store } = await createStore();
    await Promise.all([store.setApiKey("anthropic", "anthropic-key"), store.setApiKey("openai", "openai-key")]);

    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([
        { providerId: "anthropic", type: "api_key" },
        { providerId: "openai", type: "api_key" },
      ]),
    );
  });

  it("refuses to persist plaintext when encryption is unavailable", async () => {
    const encryption = new TestEncryption();
    encryption.available = false;
    const { store } = await createStore(encryption);

    await expect(store.setApiKey("anthropic", "secret-test-key")).rejects.toEqual(
      expect.objectContaining<WispBackendError>({ code: "secure_storage_unavailable" }),
    );
  });

  it("removes a configured credential", async () => {
    const { store } = await createStore();
    await store.setApiKey("anthropic", "secret-test-key");
    await store.delete("anthropic");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });
});
