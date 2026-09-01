import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSettingsStore } from "../electron/backend/ai-settings-store.js";
import { WispBackendError } from "../electron/backend/backend-error.js";
import { EncryptedCredentialStore, type EncryptionService } from "../electron/backend/encrypted-credential-store.js";
import { ModelService, type ModelRuntimeLike } from "../electron/backend/model-service.js";

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
    return Buffer.from(value, "utf8");
  }

  decrypt(value: Buffer): string {
    return value.toString("utf8");
  }
}

function createRuntime() {
  const models = [
    {
      id: "model-b",
      name: "Model B",
      api: "test",
      provider: "provider-b",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 10_000,
    },
  ];
  const providers = [
    {
      id: "provider-b",
      name: "Provider B",
      auth: { apiKey: {} },
      getModels: () => models,
    },
  ];
  return {
    getProviders: () => providers,
    getProvider: (providerId: string) => providers.find(({ id }) => id === providerId),
    getModels: (providerId?: string) => (providerId ? models.filter((model) => model.provider === providerId) : models),
    getModel: (providerId: string, modelId: string) =>
      models.find((model) => model.provider === providerId && model.id === modelId),
    setRuntimeApiKey: vi.fn(async () => undefined),
    removeRuntimeApiKey: vi.fn(async () => undefined),
  };
}

async function createService(encryption = new TestEncryption()) {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-service-"));
  directories.push(directory);
  const runtime = createRuntime();
  const credentials = new EncryptedCredentialStore(path.join(directory, "credentials.enc.json"), encryption);
  const settings = new AiSettingsStore(path.join(directory, "settings.json"));
  const service = new ModelService({
    runtime: runtime as unknown as ModelRuntimeLike,
    credentials,
    settings,
  });
  return { service, runtime, credentials, settings };
}

describe("ModelService", () => {
  it("rehydrates persisted provider authentication in a new runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-restart-"));
    directories.push(directory);
    const encryption = new TestEncryption();
    const selection = { providerId: "openrouter", modelId: "openai/gpt-oss-120b" };
    const first = await ModelService.create({ dataDirectory: directory, encryption });
    await first.save({ selection, apiKey: "secret-provider-key" });

    const restarted = await ModelService.create({ dataDirectory: directory, encryption });

    await expect(restarted.getSelection()).resolves.toEqual(selection);
    expect(restarted.getModelRuntime().hasConfiguredAuth(selection.providerId)).toBe(true);
  });

  it("requires an encrypted provider key before saving a selection", async () => {
    const { service } = await createService();
    await expect(
      service.save({
        selection: { providerId: "provider-b", modelId: "model-b" },
      }),
    ).rejects.toEqual(
      expect.objectContaining<WispBackendError>({
        code: "invalid_configuration",
      }),
    );
  });

  it("does not restore a saved selection when its encrypted credential is missing", async () => {
    const { service, settings } = await createService();
    await settings.setSelection({ providerId: "provider-b", modelId: "model-b" });

    await expect(service.getSelection()).resolves.toBeNull();
    await expect(service.getView()).resolves.toEqual(expect.objectContaining({ selection: null }));
  });

  it("reports unavailable secure storage and refuses a new key", async () => {
    const encryption = new TestEncryption();
    encryption.available = false;
    const { service, runtime } = await createService(encryption);

    await expect(service.getView()).resolves.toEqual(
      expect.objectContaining({
        secureStorageAvailable: false,
      }),
    );
    await expect(
      service.save({
        selection: { providerId: "provider-b", modelId: "model-b" },
        apiKey: "secret-provider-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining<WispBackendError>({
        code: "secure_storage_unavailable",
      }),
    );
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("saves a valid key and selection without returning the secret", async () => {
    const { service, runtime, credentials } = await createService();
    const view = await service.save({
      selection: { providerId: "provider-b", modelId: "model-b" },
      apiKey: "secret-provider-key",
    });

    expect(view.selection).toEqual({ providerId: "provider-b", modelId: "model-b" });
    expect(view.providers[0]?.credentialConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-provider-key");
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("provider-b", "secret-provider-key");
    await expect(credentials.read("provider-b")).resolves.toEqual({
      type: "api_key",
      key: "secret-provider-key",
    });
  });

  it("rejects a model that is not in the provider catalog", async () => {
    const { service } = await createService();
    await expect(
      service.save({
        selection: { providerId: "provider-b", modelId: "missing" },
        apiKey: "secret-provider-key",
      }),
    ).rejects.toEqual(
      expect.objectContaining<WispBackendError>({
        code: "invalid_configuration",
      }),
    );
  });

  it("removes the key and clears the active selection", async () => {
    const { service, runtime } = await createService();
    await service.save({
      selection: { providerId: "provider-b", modelId: "model-b" },
      apiKey: "secret-provider-key",
    });

    const view = await service.removeCredential("provider-b");

    expect(view.selection).toBeNull();
    expect(view.providers[0]?.credentialConfigured).toBe(false);
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("provider-b");
  });
});
