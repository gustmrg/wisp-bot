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
      id: "model-a",
      name: "Model A",
      api: "test",
      provider: "openrouter",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 10_000,
    },
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
      id: "openrouter",
      name: "OpenRouter",
      auth: { apiKey: {} },
      getModels: () => models.filter(({ provider }) => provider === "openrouter"),
    },
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
    getError: vi.fn(() => undefined),
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
  it("exposes API-key providers and validates selections from their catalogs", async () => {
    const { service } = await createService();

    const view = await service.getView();

    expect(view.providers.map(({ id }) => id)).toEqual(["openrouter", "provider-b"]);
    await expect(
      service.save({
        selection: { providerId: "provider-b", modelId: "model-b" },
        apiKey: "secret-provider-key",
      }),
    ).resolves.toMatchObject({ selection: { providerId: "provider-b", modelId: "model-b" } });
  });

  it("rehydrates persisted provider authentication in a new runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-restart-"));
    directories.push(directory);
    const encryption = new TestEncryption();
    const selection = { providerId: "openrouter", modelId: "openai/gpt-oss-120b" };
    const first = await ModelService.create({ dataDirectory: directory, encryption, allowModelNetwork: false });
    await first.save({ selection, apiKey: "secret-provider-key" });

    const restarted = await ModelService.create({ dataDirectory: directory, encryption, allowModelNetwork: false });

    await expect(restarted.getSelection()).resolves.toEqual(selection);
    expect(restarted.getModelRuntime().hasConfiguredAuth(selection.providerId)).toBe(true);
  });

  it("surfaces catalog load errors without dropping the provider list", async () => {
    const { service, runtime } = await createService();
    vi.mocked(runtime.getError).mockReturnValue("Availability refresh: network unreachable");

    const view = await service.getView();

    expect(view.catalogError).toBe("Availability refresh: network unreachable");
    expect(view.providers.map(({ id }) => id)).toEqual(["openrouter", "provider-b"]);
    vi.mocked(runtime.getError).mockReturnValue(undefined);
    await expect(service.getView()).resolves.toMatchObject({ catalogError: null });
  });

  it("starts from the cached catalog without waiting on the network", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-offline-start-"));
    directories.push(directory);
    // With a provider key present, a network refresh would call fetch and hang here.
    vi.stubEnv("OPENROUTER_API_KEY", "env-key");
    const fetch = vi.fn(() => new Promise<never>(() => undefined));
    vi.stubGlobal("fetch", fetch);
    try {
      await ModelService.create({ dataDirectory: directory, encryption: new TestEncryption() });

      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps saved credentials configured and reports the failure when a catalog refresh times out", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-stall-"));
    directories.push(directory);
    const encryption = new TestEncryption();
    const selection = { providerId: "openrouter", modelId: "openai/gpt-oss-120b" };
    const seeded = await ModelService.create({ dataDirectory: directory, encryption, allowModelNetwork: false });
    await seeded.save({ selection, apiKey: "secret-provider-key" });

    vi.stubEnv("OPENROUTER_API_KEY", "env-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("Request aborted")));
          }),
      ),
    );
    try {
      const stalled = await ModelService.create({ dataDirectory: directory, encryption });
      await stalled.refreshCatalog(50);

      expect(stalled.getModelRuntime().hasConfiguredAuth("openrouter")).toBe(true);
      await expect(stalled.getSelection()).resolves.toEqual(selection);
      await expect(stalled.getView()).resolves.toMatchObject({
        catalogError: expect.stringContaining("timed out"),
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("requires an encrypted provider key before saving a selection", async () => {
    const { service } = await createService();
    await expect(
      service.save({
        selection: { providerId: "openrouter", modelId: "model-a" },
      }),
    ).rejects.toEqual(
      expect.objectContaining<WispBackendError>({
        code: "invalid_configuration",
      }),
    );
  });

  it("does not restore a saved selection when its encrypted credential is missing", async () => {
    const { service, settings } = await createService();
    await settings.setSelection({ providerId: "openrouter", modelId: "model-a" });

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
        selection: { providerId: "openrouter", modelId: "model-a" },
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
      selection: { providerId: "openrouter", modelId: "model-a" },
      apiKey: "secret-provider-key",
    });

    expect(view.selection).toEqual({ providerId: "openrouter", modelId: "model-a" });
    expect(view.providers[0]?.credentialConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-provider-key");
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("openrouter", "secret-provider-key");
    await expect(credentials.read("openrouter")).resolves.toEqual({
      type: "api_key",
      key: "secret-provider-key",
    });
  });

  it("rejects a model that is not in the provider catalog", async () => {
    const { service } = await createService();
    await expect(
      service.save({
        selection: { providerId: "openrouter", modelId: "missing" },
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
      selection: { providerId: "openrouter", modelId: "model-a" },
      apiKey: "secret-provider-key",
    });

    const view = await service.removeCredential("openrouter");

    expect(view.selection).toBeNull();
    expect(view.providers[0]?.credentialConfigured).toBe(false);
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("openrouter");
  });
});

it("validates per-Wisp selections against both the catalog and the shared encrypted key", async () => {
  const { service, settings } = await createService();
  const selection = { providerId: "provider-b", modelId: "model-b" };
  await expect(service.validateConversationSelection(selection)).rejects.toMatchObject({
    code: "configuration_required",
  });
  await service.save({ selection, apiKey: "secret-key" });
  await service.save({ selection: { providerId: "openrouter", modelId: "model-a" }, apiKey: "another-key" });
  await expect(service.validateConversationSelection(selection)).resolves.toBeUndefined();
  expect(await settings.getSelection()).toEqual({ providerId: "openrouter", modelId: "model-a" });
  await expect(service.validateConversationSelection({ ...selection, modelId: "missing" })).rejects.toMatchObject({
    code: "invalid_configuration",
  });
  await service.removeCredential("provider-b");
  await expect(service.validateConversationSelection(selection)).rejects.toMatchObject({
    code: "configuration_required",
  });
});
