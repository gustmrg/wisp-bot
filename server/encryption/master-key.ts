import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { EncryptionService } from "../../backend/encrypted-credential-store.js";
import { WispBackendError } from "../../backend/backend-error.js";

/** AES-256-GCM envelope includes a key identifier; old keys can be supplied during rotation. */
export class MasterKeyEncryption implements EncryptionService {
  private readonly keys = new Map<string, Buffer>();
  private active: string | undefined;
  constructor(key?: Buffer, previousKeys: Buffer[] = []) {
    for (const material of [...previousKeys, ...(key ? [key] : [])]) {
      if (material.length !== 32) throw new Error("The master key must contain exactly 32 bytes.");
      const id = createHash("sha256").update(material).digest("hex").slice(0, 16);
      this.keys.set(id, Buffer.from(material));
      if (material === key) this.active = id;
    }
  }
  static fromFile(file?: string, previousFile?: string): MasterKeyEncryption {
    if (!file) {
      if (previousFile) throw new Error("Specify a current master key when rotating keys.");
      return new MasterKeyEncryption();
    }
    const read = (name: string): Buffer => {
      const stat = lstatSync(name);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error("The master key must be a private regular file (mode 0600 or 0400).");
      return readFileSync(name);
    };
    return new MasterKeyEncryption(read(file), previousFile ? [read(previousFile)] : []);
  }
  isAvailable(): boolean {
    return this.active !== undefined;
  }
  encrypt(value: string): Buffer {
    if (!this.active)
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Configure a master key before storing provider credentials.",
      );
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.active)!, nonce);
    const aad = Buffer.from(`wisp:v1:${this.active}`);
    cipher.setAAD(aad);
    const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.from(
      JSON.stringify({
        version: 1,
        keyId: this.active,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        payload: payload.toString("base64"),
      }),
    );
  }
  decrypt(value: Buffer): string {
    const envelope = JSON.parse(value.toString("utf8")) as {
      version: number;
      keyId: string;
      nonce: string;
      tag: string;
      payload: string;
    };
    const key = this.keys.get(envelope.keyId);
    if (envelope.version !== 1 || !key)
      throw new WispBackendError(
        "secure_storage_unavailable",
        "The required credential encryption key is unavailable.",
      );
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(Buffer.from(`wisp:v1:${envelope.keyId}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.payload, "base64")), decipher.final()]).toString("utf8");
  }
}
