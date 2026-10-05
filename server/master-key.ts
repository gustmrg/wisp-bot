import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";

import { WispBackendError } from "../backend/backend-error.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";

const KEY_BYTES = 32;

interface Envelope {
  version: 1;
  keyId: string;
  nonce: string;
  tag: string;
  payload: string;
}

/**
 * Encrypts stored credentials with AES-256-GCM under a 32-byte key kept in a
 * private file outside the data directory. Each envelope names its key, so a
 * later key rotation can still read older ciphertext.
 */
export class MasterKeyEncryption implements EncryptionService {
  private readonly keyId: string | undefined;

  constructor(private readonly key?: Buffer) {
    if (key && key.length !== KEY_BYTES) throw new Error("The master key must contain exactly 32 bytes.");
    this.keyId = key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : undefined;
  }

  /** Reads the key, refusing files other accounts could read or replace. */
  static fromFile(file: string | undefined): MasterKeyEncryption {
    if (!file) return new MasterKeyEncryption();
    const stat = lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error("The master key must be a regular file readable only by its owner (mode 0600 or 0400).");
    }
    return new MasterKeyEncryption(readFileSync(file));
  }

  /** Writes a new random key; never overwrites an existing file. */
  static generate(file: string): void {
    writeFileSync(file, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
  }

  isAvailable(): boolean {
    return this.key !== undefined;
  }

  encrypt(value: string): Buffer {
    const { key, keyId } = this.requireKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`wisp:v1:${keyId}`));
    const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      keyId,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      payload: payload.toString("base64"),
    };
    return Buffer.from(JSON.stringify(envelope));
  }

  decrypt(value: Buffer): string {
    const { key, keyId } = this.requireKey();
    const envelope = JSON.parse(value.toString("utf8")) as Envelope;
    if (envelope.version !== 1 || envelope.keyId !== keyId) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "These credentials were stored with a different master key.",
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(Buffer.from(`wisp:v1:${keyId}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.payload, "base64")), decipher.final()]).toString("utf8");
  }

  private requireKey(): { key: Buffer; keyId: string } {
    if (!this.key || !this.keyId) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Start the server with a master key file to store credentials.",
      );
    }
    return { key: this.key, keyId: this.keyId };
  }
}
