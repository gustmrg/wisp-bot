import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSettingsStore } from "../backend/ai-settings-store.js";
import { WispBackendError } from "../backend/backend-error.js";
import { EncryptedCredentialStore, type EncryptionService } from "../backend/encrypted-credential-store.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { ModelService, supportedThinkingLevels, type ModelRuntimeLike } from "../backend/model-service.js";

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
      id: "vision-b",
      name: "Vision B",
      api: "test",
      provider: "provider-b",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text", "image"],
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
      thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
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

  it("lists only the thinking levels each model supports", async () => {
    const { service } = await createService();
    const view = await service.getView();
    const models = view.providers.flatMap((provider) => provider.models);

    expect(models.find(({ id }) => id === "vision-b")?.thinkingLevels).toEqual(["off"]);
    expect(models.find(({ id }) => id === "model-a")?.thinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(models.find(({ id }) => id === "model-b")?.thinkingLevels).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("agrees with Pi on the levels a model supports", () => {
    const maps = [
      undefined,
      {},
      { minimal: null, xhigh: "xhigh" },
      { off: null, max: "max" },
      { off: null, minimal: null, low: null, medium: null, high: null },
    ];
    for (const reasoning of [false, true]) {
      for (const thinkingLevelMap of maps) {
        const model = { reasoning, thinkingLevelMap } as Parameters<typeof getSupportedThinkingLevels>[0];
        expect(supportedThinkingLevels(model)).toEqual(getSupportedThinkingLevels(model));
      }
    }
  });

  it("saves a supported thinking level and refuses one the model does not support", async () => {
    const { service } = await createService();
    const view = await service.save({
      selection: { providerId: "provider-b", modelId: "model-b", thinkingLevel: "xhigh" },
      apiKey: "secret-provider-key",
    });
    expect(view.selection).toEqual({ providerId: "provider-b", modelId: "model-b", thinkingLevel: "xhigh" });
    await expect(service.getSelection()).resolves.toEqual(view.selection);

    for (const selection of [
      { providerId: "provider-b", modelId: "model-b", thinkingLevel: "minimal" as const },
      { providerId: "provider-b", modelId: "vision-b", thinkingLevel: "low" as const },
    ]) {
      await expect(service.save({ selection })).rejects.toMatchObject({ code: "invalid_configuration" });
    }
    // "off" is the default every model accepts; Pi clamps it for one that always reasons.
    await expect(
      service.save({ selection: { providerId: "provider-b", modelId: "vision-b", thinkingLevel: "off" } }),
    ).resolves.toMatchObject({ selection: { providerId: "provider-b", modelId: "vision-b" } });
  });

  it("saves a key outside a selection and reads it back for direct provider calls", async () => {
    const { service, runtime } = await createService();

    await expect(service.setApiKey("groq", "   ")).rejects.toMatchObject({ code: "invalid_request" });
    await service.setApiKey("groq", "  voice-key  ");

    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("groq", "voice-key");
    await expect(service.getApiKey("groq")).resolves.toBe("voice-key");
    await expect(service.getApiKey("openai")).resolves.toBeUndefined();
    expect([...(await service.listCredentialProviders())]).toEqual(["groq"]);
    expect((await service.getView()).selection).toBeNull();
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

describe("ModelService auxiliary models", () => {
  const vision = { providerId: "provider-b", modelId: "vision-b" };

  it("saves an image model whose provider has a key, and turns it off", async () => {
    const { service } = await createService();
    await service.setApiKey("provider-b", "secret-key");

    const view = await service.saveAuxiliary("imageUnderstanding", { ...vision, maxOutputTokens: 50 });

    expect(view.auxiliary.imageUnderstanding).toEqual({ selection: vision, unavailable: null });
    await expect(service.getAuxiliaryModel("imageUnderstanding")).resolves.toEqual(vision);
    const off = await service.saveAuxiliary("imageUnderstanding", null);
    expect(off.auxiliary.imageUnderstanding).toEqual({ selection: null, unavailable: null });
    await expect(service.getAuxiliaryModel("imageUnderstanding")).resolves.toBeNull();
  });

  it("refuses models without image input, without a saved key, or outside the catalog", async () => {
    const { service } = await createService();
    await expect(service.saveAuxiliary("imageUnderstanding", vision)).rejects.toMatchObject({
      code: "invalid_configuration",
      message: expect.stringContaining("API key"),
    });
    await service.setApiKey("provider-b", "secret-key");
    await expect(
      service.saveAuxiliary("imageUnderstanding", { providerId: "provider-b", modelId: "model-b" }),
    ).rejects.toMatchObject({ code: "invalid_configuration", message: "This model does not accept images." });
    await expect(
      service.saveAuxiliary("imageUnderstanding", { providerId: "provider-b", modelId: "missing" }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    expect((await service.getView()).auxiliary.imageUnderstanding.selection).toBeNull();
  });

  it("keeps the selection but treats it as off when its provider loses the key", async () => {
    const { service } = await createService();
    await service.save({ selection: { providerId: "openrouter", modelId: "model-a" }, apiKey: "main-key" });
    await service.setApiKey("provider-b", "secret-key");
    await service.saveAuxiliary("imageUnderstanding", vision);

    const view = await service.removeCredential("provider-b");

    expect(view.selection).toEqual({ providerId: "openrouter", modelId: "model-a" });
    expect(view.auxiliary.imageUnderstanding).toEqual({ selection: vision, unavailable: "missing_key" });
    await expect(service.getAuxiliaryModel("imageUnderstanding")).resolves.toBeNull();
  });

  it("reports a saved model that left the catalog as unavailable instead of replacing it", async () => {
    const { service, settings } = await createService();
    await service.setApiKey("provider-b", "secret-key");
    await settings.setAuxiliary("imageUnderstanding", { providerId: "provider-b", modelId: "retired" });

    expect((await service.getView()).auxiliary.imageUnderstanding).toEqual({
      selection: { providerId: "provider-b", modelId: "retired" },
      unavailable: "model_unavailable",
    });
    await expect(service.getAuxiliaryModel("imageUnderstanding")).resolves.toBeNull();
  });
});

describe("ModelService fallback models", () => {
  const global = { providerId: "openrouter", modelId: "model-a" };
  const backup = { providerId: "provider-b", modelId: "model-b" };

  it("saves a global fallback whose provider has a key, and turns it off", async () => {
    const { service } = await createService();
    await expect(service.saveFallback(backup)).rejects.toMatchObject({
      code: "invalid_configuration",
      message: expect.stringContaining("API key"),
    });
    await service.setApiKey("provider-b", "secret-key");
    await expect(service.saveFallback({ providerId: "provider-b", modelId: "missing" })).rejects.toMatchObject({
      code: "invalid_configuration",
    });

    const view = await service.saveFallback({ ...backup, thinkingLevel: "high" });
    expect(view.fallback).toEqual({ selection: backup, unavailable: null });
    expect((await service.saveFallback(null)).fallback).toEqual({ selection: null, unavailable: null });
  });

  it("gives Wisps on the global model the global fallback, and Wisps with their own model none until they choose", async () => {
    const { service } = await createService();
    await service.save({ selection: global, apiKey: "main-key" });
    await service.setApiKey("provider-b", "secret-key");
    await service.saveFallback(backup);
    const own = { providerId: "provider-b", modelId: "vision-b" };

    await expect(service.getFallbackModel(null, null)).resolves.toEqual(backup);
    await expect(service.getFallbackModel(own, null)).resolves.toBeNull();
    await expect(service.getFallbackModel(own, "global")).resolves.toEqual(backup);
    await expect(service.getFallbackModel(null, "off")).resolves.toBeNull();
    await expect(service.getFallbackModel(own, global)).resolves.toEqual(global);
  });

  it("has no fallback when it is the model that failed or cannot be used", async () => {
    const { service, settings } = await createService();
    await service.save({ selection: global, apiKey: "main-key" });
    await service.setApiKey("provider-b", "secret-key");

    // The model cannot stand in for itself.
    await expect(service.getFallbackModel(null, global)).resolves.toBeNull();
    await expect(service.getFallbackModel(backup, backup)).resolves.toBeNull();
    // A saved model that left the catalog, or whose key is gone, is kept but not used.
    await settings.setFallback({ providerId: "provider-b", modelId: "retired" });
    expect((await service.getView()).fallback).toEqual({
      selection: { providerId: "provider-b", modelId: "retired" },
      unavailable: "model_unavailable",
    });
    await expect(service.getFallbackModel(null, null)).resolves.toBeNull();
    await service.saveFallback(backup);
    const view = await service.removeCredential("provider-b");
    expect(view.fallback).toEqual({ selection: backup, unavailable: "missing_key" });
    await expect(service.getFallbackModel(null, null)).resolves.toBeNull();
  });
});
