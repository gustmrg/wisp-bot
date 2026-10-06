import { readFile } from "node:fs/promises";

import { writeFileAtomically } from "./atomic-file.js";
import { WispBackendError } from "./backend-error.js";
import type { EncryptionService } from "./encrypted-credential-store.js";

/**
 * Authentication secrets for MCP connections: configured header values and
 * OAuth tokens. Values are encrypted at rest and never returned to the
 * renderer. This store is intentionally separate from the Pi-coupled provider
 * credential store so resetting one never silently affects the other.
 */
export type McpSecret =
  | { type: "header"; headerName: string; headerValue: string }
  | {
      type: "oauth";
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      scope?: string;
      /** Dynamic client registration data, persisted per the MCP authorization spec. */
      clientRegistration?: { clientId: string; clientSecret?: string; issuer?: string };
    };

interface McpSecretFile {
  schemaVersion: 1;
  payload: string;
}

type SecretMap = Record<string, McpSecret>;

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export class McpSecretStore {
  private readonly filePath: string;
  private readonly encryption: EncryptionService;
  private operationChain: Promise<unknown> = Promise.resolve();
  private cached: SecretMap | undefined;

  constructor(filePath: string, encryption: EncryptionService) {
    this.filePath = filePath;
    this.encryption = encryption;
  }

  isSecureStorageAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  /** Throws when the file exists but cannot be decrypted; callers surface recovery guidance. */
  async read(serverId: string): Promise<McpSecret | undefined> {
    const secrets = await this.readAll();
    const secret = secrets[serverId];
    return secret ? structuredClone(secret) : undefined;
  }

  async hasOAuthTokens(serverId: string): Promise<boolean> {
    const secret = await this.read(serverId);
    return secret?.type === "oauth" && secret.accessToken !== "";
  }

  async setHeader(serverId: string, headerName: string, headerValue: string): Promise<void> {
    await this.modify(serverId, () => ({ type: "header", headerName, headerValue }));
  }

  async setOAuthTokens(serverId: string, tokens: McpOAuthTokens): Promise<void> {
    // Preserve any persisted client registration: the refresh token stays
    // associated with that client identity.
    await this.modify(serverId, (current) => {
      const clientRegistration =
        current?.type === "oauth" && current.clientRegistration ? current.clientRegistration : undefined;
      return { type: "oauth", ...tokens, ...(clientRegistration ? { clientRegistration } : {}) };
    });
  }

  async oauthTokens(serverId: string): Promise<McpOAuthTokens | undefined> {
    const secret = await this.read(serverId);
    // Registration-only placeholders carry no usable tokens.
    return secret?.type === "oauth" && secret.accessToken !== "" ? { ...secret } : undefined;
  }

  async oauthClientRegistration(
    serverId: string,
  ): Promise<{ clientId: string; clientSecret?: string; issuer?: string } | undefined> {
    const secret = await this.read(serverId);
    return secret?.type === "oauth"
      ? secret.clientRegistration
        ? { ...secret.clientRegistration }
        : undefined
      : undefined;
  }

  async setOAuthClientRegistration(
    serverId: string,
    registration: { clientId: string; clientSecret?: string; issuer?: string },
  ): Promise<void> {
    await this.enqueue(async () => {
      const secrets = await this.readAll();
      const secret = secrets[serverId];
      // Registration happens before the first token exchange, so persist it
      // even when no oauth secret exists yet by keeping a placeholder.
      if (secret?.type === "oauth") {
        secrets[serverId] = { ...secret, clientRegistration: registration };
      } else if (!secret) {
        secrets[serverId] = { type: "oauth", accessToken: "", clientRegistration: registration };
      } else {
        return;
      }
      await this.writeAll(secrets);
    });
  }

  async clearOAuthTokens(serverId: string): Promise<void> {
    await this.enqueue(async () => {
      const secrets = await this.readAll();
      const secret = secrets[serverId];
      if (secret?.type !== "oauth") return;
      // Invalidate only the tokens; the client identity stays registered.
      secrets[serverId] = {
        type: "oauth",
        accessToken: "",
        ...(secret.clientRegistration ? { clientRegistration: secret.clientRegistration } : {}),
      };
      await this.writeAll(secrets);
    });
  }

  async delete(serverId: string): Promise<void> {
    await this.enqueue(async () => {
      const secrets = await this.readAll();
      if (!(serverId in secrets)) return;
      delete secrets[serverId];
      await this.writeAll(secrets);
    });
  }

  /** Removes every secret; used by explicit recovery of unreadable storage. */
  async deleteAll(): Promise<void> {
    await this.enqueue(async () => {
      await this.writeAll({});
    });
  }

  private async modify(serverId: string, next: (current: McpSecret | undefined) => McpSecret): Promise<void> {
    await this.enqueue(async () => {
      const secrets = await this.readAll();
      secrets[serverId] = next(secrets[serverId]);
      await this.writeAll(secrets);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation) as Promise<T>;
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAll(): Promise<SecretMap> {
    if (this.cached) return this.cached;
    try {
      const file = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<McpSecretFile>;
      if (file.schemaVersion !== 1 || typeof file.payload !== "string") throw new Error("Unsupported secret file.");
      this.assertEncryptionAvailable();
      this.cached = normalizeSecrets(JSON.parse(this.encryption.decrypt(Buffer.from(file.payload, "base64"))));
      return this.cached;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(secrets: SecretMap): Promise<void> {
    this.assertEncryptionAvailable();
    const payload = this.encryption.encrypt(JSON.stringify(secrets)).toString("base64");
    const file: McpSecretFile = { schemaVersion: 1, payload };
    await writeFileAtomically(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
    this.cached = secrets;
  }

  private assertEncryptionAvailable(): void {
    if (!this.encryption.isAvailable()) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Secure credential storage is unavailable on this device.",
      );
    }
  }
}

function normalizeSecrets(value: unknown): SecretMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, McpSecret] => {
      const candidate = entry[1];
      if (!candidate || typeof candidate !== "object") return false;
      const record = candidate as Record<string, unknown>;
      if (record.type === "header")
        return typeof record.headerName === "string" && typeof record.headerValue === "string";
      return record.type === "oauth" && typeof record.accessToken === "string";
    }),
  );
}
