import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const KEY_TYPE = "ssh-ed25519";

/**
 * The key Wisp adds to a server that only accepted a password, so it can
 * connect again without asking. An ed25519 key in OpenSSH's format, without
 * a passphrase, readable only by this user, like a key from `ssh-keygen`.
 */
export class WispSshKey {
  constructor(readonly file: string) {}

  /** The private key's path once it exists. */
  get identityFile(): string | undefined {
    return existsSync(this.file) ? this.file : undefined;
  }

  /** The public key line, creating the key first if needed. */
  async publicKey(comment: string): Promise<string> {
    if (!existsSync(this.file)) {
      const { privateKey, publicKey } = createKeyPair(sanitizeComment(comment));
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // "wx": never replace a key a server may already trust.
      await writeFile(this.file, privateKey, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!existsSync(`${this.file}.pub`)) await writeFile(`${this.file}.pub`, `${publicKey}\n`, { mode: 0o644 });
    }
    return (await readFile(`${this.file}.pub`, "utf8")).trim();
  }
}

/** A comment safe to pass through a remote shell: letters, digits, and `._@-`. */
export function sanitizeComment(comment: string): string {
  return `wisp@${comment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "desktop"}`.slice(0, 64);
}

/** Writes an ed25519 key pair the way `ssh-keygen -t ed25519 -N ""` does. */
export function createKeyPair(comment: string): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const pub = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(pair.privateKey.export({ format: "jwk" }).d!, "base64url");
  const publicBlob = Buffer.concat([sshString(KEY_TYPE), sshString(pub)]);
  const check = randomBytes(4);
  const privateBody = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  // Padded to the cipher block size, 8 for "none", with the bytes 1, 2, 3…
  const padding = Buffer.from(Array.from({ length: (8 - (privateBody.length % 8)) % 8 }, (_, index) => index + 1));
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(Buffer.concat([privateBody, padding])),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${KEY_TYPE} ${publicBlob.toString("base64")} ${comment}`,
  };
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function sshString(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([uint32(bytes.length), bytes]);
}
