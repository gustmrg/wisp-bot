import { readFile } from "node:fs/promises";

import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import { WispBackendError } from "./backend-error.js";
import { writeFileAtomically } from "./atomic-file.js";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = Exclude<Awaited<ReturnType<CredentialStore["read"]>>, undefined>;
type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];
type AuthOperationOptions = Parameters<CredentialStore["read"]>[1];

export interface EncryptionService {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface EncryptedCredentialFile {
  schemaVersion: 1;
  payload: string;
}

type CredentialMap = Record<string, Credential>;

function throwIfAborted(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted();
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    return (
      (candidate.key === undefined || typeof candidate.key === "string") &&
      (candidate.env === undefined || (candidate.env !== null && typeof candidate.env === "object"))
    );
  }
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number"
  );
}

function normalizeCredentials(value: unknown): CredentialMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Credential] => isCredential(entry[1])),
  );
}

export class EncryptedCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly encryption: EncryptionService;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(filePath: string, encryption: EncryptionService) {
    this.filePath = filePath;
    this.encryption = encryption;
  }

  isSecureStorageAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options);
    return (await this.readAll())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    throwIfAborted(options);
    return Object.entries(await this.readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      throwIfAborted(options);
      const credentials = await this.readAll();
      const current = credentials[providerId];
      const next = await fn(current);
      throwIfAborted(options);
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.writeAll(credentials);
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      throwIfAborted(options);
      const credentials = await this.readAll();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.writeAll(credentials);
    });
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readAll(): Promise<CredentialMap> {
    try {
      const file = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<EncryptedCredentialFile>;
      if (file.schemaVersion !== 1 || typeof file.payload !== "string") {
        throw new Error("Unsupported credential file.");
      }
      this.assertEncryptionAvailable();
      const plaintext = this.encryption.decrypt(Buffer.from(file.payload, "base64"));
      return normalizeCredentials(JSON.parse(plaintext));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(credentials: CredentialMap): Promise<void> {
    this.assertEncryptionAvailable();
    const payload = this.encryption.encrypt(JSON.stringify(credentials)).toString("base64");
    const file: EncryptedCredentialFile = { schemaVersion: 1, payload };
    await writeFileAtomically(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
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
