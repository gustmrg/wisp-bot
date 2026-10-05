import { randomBytes } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "../../backend/atomic-file.js";
import type { EncryptionService } from "../../backend/encrypted-credential-store.js";
import type { StructuredLogger } from "../../backend/structured-logger.js";

const KEY_FILE = "local-server-key.json";
/** Every store that keeps credentials as `{ schemaVersion: 1, payload: base64(ciphertext) }`. */
export const CREDENTIAL_FILES = ["credentials.enc.json", "plugin-credentials.enc.json", "mcp-credentials.enc.json"];

/**
 * The key the local server encrypts credentials with, itself encrypted by the
 * system keychain. Resolves undefined when the keychain is unavailable, so the
 * server refuses to save credentials, as the app always has.
 */
export async function loadOrCreateLocalMasterKey(
  directory: string,
  keychain: EncryptionService,
): Promise<Buffer | undefined> {
  if (!keychain.isAvailable()) return undefined;
  const file = path.join(directory, KEY_FILE);
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as { version?: number; key?: string };
    if (stored.version === 1 && typeof stored.key === "string") {
      const key = Buffer.from(keychain.decrypt(Buffer.from(stored.key, "base64")), "base64");
      if (key.length === 32) return key;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  const sealed = keychain.encrypt(key.toString("base64")).toString("base64");
  await writeFileAtomically(file, `${JSON.stringify({ version: 1, key: sealed })}\n`);
  return key;
}

/**
 * Re-encrypts credentials saved by earlier versions, which encrypted them with
 * the keychain directly, under the server's key. Each original is kept beside
 * it as `.keychain-backup`. Files already migrated, missing, or unreadable are
 * left alone; the server then asks for those keys again.
 */
export async function migrateKeychainCredentials(
  backendDirectory: string,
  keychain: EncryptionService,
  serverKey: EncryptionService,
  logger: Pick<StructuredLogger, "info" | "warn">,
): Promise<void> {
  if (!keychain.isAvailable() || !serverKey.isAvailable()) return;
  for (const name of CREDENTIAL_FILES) {
    const file = path.join(backendDirectory, name);
    let stored: { schemaVersion?: number; payload?: string };
    try {
      stored = JSON.parse(await readFile(file, "utf8")) as typeof stored;
    } catch {
      continue;
    }
    if (stored.schemaVersion !== 1 || typeof stored.payload !== "string") continue;
    const ciphertext = Buffer.from(stored.payload, "base64");
    if (isServerEnvelope(ciphertext)) continue;
    try {
      const plaintext = keychain.decrypt(ciphertext);
      await copyFile(file, `${file}.keychain-backup`);
      const payload = serverKey.encrypt(plaintext).toString("base64");
      await writeFileAtomically(file, `${JSON.stringify({ schemaVersion: 1, payload }, null, 2)}\n`);
      logger.info("credentials_migrated", { file: name });
    } catch {
      logger.warn("credentials_migration_failed", { file: name });
    }
  }
}

function isServerEnvelope(ciphertext: Buffer): boolean {
  try {
    const envelope = JSON.parse(ciphertext.toString("utf8")) as { version?: unknown; keyId?: unknown };
    return envelope.version === 1 && typeof envelope.keyId === "string";
  } catch {
    return false;
  }
}
