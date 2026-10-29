import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiSettingsStore } from "../backend/ai-settings-store.js";
import { WispBackendError } from "../backend/backend-error.js";
import { EncryptedCredentialStore, type EncryptionService } from "../backend/encrypted-credential-store.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { ModelService, supportedThinkingLevels, type ModelRuntimeLike } from "../backend/model-service.js";
import { CLAUDE_CODE_PROVIDER, type ClaudeCodeStatusView } from "../shared/claude-code.js";

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
  const voiceCredentials = new EncryptedCredentialStore(path.join(directory, "voice-credentials.enc.json"), encryption);
  const settings = new AiSettingsStore(path.join(directory, "settings.json"));
  const service = new ModelService({
    runtime: runtime as unknown as ModelRuntimeLike,
    credentials,
    voiceCredentials,
    settings,
  });
  return { service, runtime, credentials, voiceCredentials, settings };
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

  it("saves a voice key as the provider's shared key and reads it back for direct provider calls", async () => {
    const { service, runtime, voiceCredentials } = await createService();

    await expect(service.saveVoiceKey("groq", "   ")).rejects.toMatchObject({ code: "invalid_request" });
    await service.saveVoiceKey("groq", "  voice-key  ");

    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith("groq", "voice-key");
    await expect(service.getVoiceKey("groq")).resolves.toBe("voice-key");
    await expect(service.getVoiceKey("openai")).resolves.toBeUndefined();
    await expect(service.listVoiceKeys()).resolves.toEqual(new Map([["groq", "shared"]]));
    await expect(voiceCredentials.list()).resolves.toEqual([]);
    expect([...(await service.listCredentialProviders())]).toEqual(["groq"]);
    expect((await service.getView()).selection).toBeNull();
  });

  it("removes a shared voice key for the provider's chat models too", async () => {
    const { service } = await createService();
    await service.saveVoiceKey("provider-b", "voice-key");

    await service.removeVoiceKey("provider-b");

    await expect(service.getVoiceKey("provider-b")).resolves.toBeUndefined();
    expect([...(await service.listCredentialProviders())]).toEqual([]);
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
    await service.saveVoiceKey("provider-b", "secret-key");

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
    await service.saveVoiceKey("provider-b", "secret-key");
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
    await service.saveVoiceKey("provider-b", "secret-key");
    await service.saveAuxiliary("imageUnderstanding", vision);

    const view = await service.removeCredential("provider-b");

    expect(view.selection).toEqual({ providerId: "openrouter", modelId: "model-a" });
    expect(view.auxiliary.imageUnderstanding).toEqual({ selection: vision, unavailable: "missing_key" });
    await expect(service.getAuxiliaryModel("imageUnderstanding")).resolves.toBeNull();
  });

  it("reports a saved model that left the catalog as unavailable instead of replacing it", async () => {
    const { service, settings } = await createService();
    await service.saveVoiceKey("provider-b", "secret-key");
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
    await service.saveVoiceKey("provider-b", "secret-key");
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
    await service.saveVoiceKey("provider-b", "secret-key");
    await service.saveFallback(backup);
    const own = { providerId: "provider-b", modelId: "vision-b" };

    await expect(service.getFallbackModel(null, null)).resolves.toEqual(backup);
    await expect(service.getFallbackModel(own, null)).resolves.toBeNull();
    await expect(service.getFallbackModel(global, "global")).resolves.toEqual(backup);
    await expect(service.getFallbackModel(null, "off")).resolves.toBeNull();
    await expect(service.getFallbackModel(own, global)).resolves.toEqual(global);
  });

  it("uses no fallback from the provider of the model it stands in for, keeping a saved one", async () => {
    const { service, settings } = await createService();
    await service.save({ selection: global, apiKey: "main-key" });
    await service.saveVoiceKey("provider-b", "secret-key");
    const own = { providerId: "provider-b", modelId: "vision-b" };

    // A Wisp's own fallback from its model's provider, saved before the rule.
    await expect(service.getFallbackModel(own, backup)).resolves.toBeNull();
    await expect(service.assertUsableFallback(backup, own)).rejects.toMatchObject({
      code: "invalid_configuration",
      message: expect.stringContaining("another provider"),
    });
    await expect(service.assertUsableFallback(global, own)).resolves.toBeUndefined();

    // The global fallback is judged against the model of the Wisp that falls back.
    await service.saveFallback(backup);
    await expect(service.getFallbackModel(own, "global")).resolves.toBeNull();
    await expect(service.getFallbackModel(null, null)).resolves.toEqual(backup);

    // Moving the global model to the fallback's provider keeps the fallback, unused.
    await settings.setSelection({ providerId: "provider-b", modelId: "model-b" });
    expect((await service.getView()).fallback).toEqual({ selection: backup, unavailable: "same_provider" });
    await expect(service.getFallbackModel(null, null)).resolves.toBeNull();
    await expect(service.saveFallback(backup)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(service.getFallbackModel({ providerId: "openrouter", modelId: "model-a" }, "global")).resolves.toEqual(
      backup,
    );
  });

  it("has no fallback when it is the model that failed or cannot be used", async () => {
    const { service, settings } = await createService();
    await service.save({ selection: global, apiKey: "main-key" });
    await service.saveVoiceKey("provider-b", "secret-key");

    // The model, or its provider, cannot stand in for itself.
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

describe("ModelService subscription sign-in", () => {
  const AUTH_URL = "https://auth.openai.test/authorize?state=abc";
  const REDIRECT = "http://127.0.0.1:1455/auth/callback?code=the-code&state=abc";

  function chatModel(provider: string) {
    return {
      id: `${provider}-chat`,
      name: `${provider} chat`,
      api: "test",
      provider,
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 10_000,
    };
  }

  /**
   * A runtime whose providers sign in like Pi's: the login reports the page,
   * waits for the browser or a pasted redirect, and stores the credential.
   */
  function createSignInRuntime(credentials: EncryptedCredentialStore) {
    const models = [chatModel("openai"), chatModel("anthropic")];
    const oauth = { name: "Subscription", isSubscription: true, loginLabel: "Sign in with ChatGPT" };
    const providers = [
      { id: "openai", name: "OpenAI", auth: { apiKey: {}, oauth } },
      { id: "anthropic", name: "Anthropic", auth: { apiKey: {}, oauth: { ...oauth, loginLabel: undefined } } },
    ];
    let completeInBrowser: (() => void) | undefined;
    const runtime = {
      getProviders: () => providers,
      getProvider: (providerId: string) => providers.find(({ id }) => id === providerId),
      getModels: (providerId?: string) => models.filter((model) => !providerId || model.provider === providerId),
      getModel: (providerId: string, modelId: string) =>
        models.find((model) => model.provider === providerId && model.id === modelId),
      getError: vi.fn(() => undefined),
      setRuntimeApiKey: vi.fn(async () => undefined),
      removeRuntimeApiKey: vi.fn(async () => undefined),
      logout: vi.fn(async (providerId: string) => credentials.delete(providerId)),
      login: vi.fn(
        async (
          providerId: string,
          _type: "oauth",
          interaction: Parameters<ModelRuntimeLike["login"]>[2],
          options?: Parameters<ModelRuntimeLike["login"]>[3],
        ) => {
          interaction.notify({ type: "auth_url", url: AUTH_URL });
          const browser = new Promise<string>((resolve) => {
            completeInBrowser = () => resolve(REDIRECT);
          });
          const redirect = await Promise.race([
            browser,
            interaction.prompt({ type: "manual_code", message: "Paste the address" }),
          ]);
          if (redirect !== REDIRECT) throw new Error("OAuth state mismatch");
          const credential = {
            type: "oauth" as const,
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            deviceId: options?.getDeviceId?.(),
          };
          await credentials.modify(providerId, async () => credential);
          return credential;
        },
      ),
    };
    return { runtime, completeInBrowser: () => completeInBrowser?.() };
  }

  async function createSignInService(options: { browser?: "local" | "manual" } = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-sign-in-"));
    directories.push(directory);
    const credentials = new EncryptedCredentialStore(
      path.join(directory, "credentials.enc.json"),
      new TestEncryption(),
    );
    const voiceCredentials = new EncryptedCredentialStore(
      path.join(directory, "voice-credentials.enc.json"),
      new TestEncryption(),
    );
    const { runtime, completeInBrowser } = createSignInRuntime(credentials);
    const openExternal = vi.fn(async (_url: string) => undefined);
    const service = new ModelService({
      runtime: runtime as unknown as ModelRuntimeLike,
      credentials,
      voiceCredentials,
      settings: new AiSettingsStore(path.join(directory, "settings.json")),
      openExternal,
      signInBrowser: async () => ({ kind: options.browser ?? "local" }),
    });
    return { service, runtime, credentials, voiceCredentials, openExternal, completeInBrowser };
  }

  async function waitForSignInToEnd(service: ModelService) {
    await vi.waitFor(async () => expect((await service.getView()).providerSignIn).toBeNull());
  }

  it("offers a subscription sign-in only for providers Wisp allows", async () => {
    const { service } = await createSignInService();

    const view = await service.getView();

    expect(view.providers.find(({ id }) => id === "openai")?.subscriptionSignIn).toEqual({
      label: "Sign in with ChatGPT",
    });
    // Pi's Claude sign-in poses as Claude Code, which Anthropic does not allow for other apps.
    expect(view.providers.find(({ id }) => id === "anthropic")?.subscriptionSignIn).toBeUndefined();
    await expect(service.startSignIn("anthropic")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("opens the browser here and uses the subscription once the sign-in completes", async () => {
    const { service, runtime, credentials, openExternal, completeInBrowser } = await createSignInService();

    const started = await service.startSignIn("openai");

    expect(openExternal).toHaveBeenCalledWith(AUTH_URL);
    expect(started.providerSignIn).toEqual({ providerId: "openai", status: "waiting" });
    completeInBrowser();
    await waitForSignInToEnd(service);

    const credential = await credentials.read("openai");
    expect(credential).toMatchObject({ type: "oauth", access: "access-token" });
    // The installation ID is a stable UUID the provider sees as this app's host.
    expect((credential as { deviceId?: string }).deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith("openai");
    const view = await service.save({ selection: { providerId: "openai", modelId: "openai-chat" } });
    expect(view.providers.find(({ id }) => id === "openai")).toMatchObject({
      credentialConfigured: true,
      credentialKind: "subscription",
    });
    await expect(service.getSelection()).resolves.toEqual({ providerId: "openai", modelId: "openai-chat" });
    await expect(
      service.validateConversationSelection({ providerId: "openai", modelId: "openai-chat" }),
    ).resolves.toBeUndefined();
    // Voice input needs a key; the sign-in does not count as one.
    await expect(service.listVoiceKeys()).resolves.toEqual(new Map());
  });

  async function signIn(service: ModelService, completeInBrowser: () => void) {
    await service.startSignIn("openai");
    completeInBrowser();
    await waitForSignInToEnd(service);
  }

  it("keeps a voice key apart from the sign-in, which it leaves in place", async () => {
    const { service, runtime, credentials, completeInBrowser } = await createSignInService();
    await signIn(service, completeInBrowser);

    await service.saveVoiceKey("openai", "voice-key");

    await expect(credentials.read("openai")).resolves.toMatchObject({ type: "oauth" });
    expect(runtime.setRuntimeApiKey).not.toHaveBeenCalled();
    await expect(service.getVoiceKey("openai")).resolves.toBe("voice-key");
    await expect(service.listVoiceKeys()).resolves.toEqual(new Map([["openai", "voice"]]));

    await service.removeVoiceKey("openai");

    expect(runtime.logout).not.toHaveBeenCalled();
    await expect(credentials.read("openai")).resolves.toMatchObject({ type: "oauth" });
    await expect(service.getVoiceKey("openai")).resolves.toBeUndefined();
  });

  it("keeps the API key for voice input when signing in, and after signing out", async () => {
    const { service, credentials, voiceCredentials, completeInBrowser } = await createSignInService();
    await service.saveVoiceKey("openai", "api-key");

    await signIn(service, completeInBrowser);

    await expect(credentials.read("openai")).resolves.toMatchObject({ type: "oauth" });
    await expect(service.getVoiceKey("openai")).resolves.toBe("api-key");
    await expect(service.listVoiceKeys()).resolves.toEqual(new Map([["openai", "voice"]]));

    await service.removeCredential("openai");

    await expect(service.getVoiceKey("openai")).resolves.toBe("api-key");

    // A key saved for the models afterwards is shared with voice input again.
    await service.saveVoiceKey("openai", "new-key");

    await expect(service.getVoiceKey("openai")).resolves.toBe("new-key");
    await expect(service.listVoiceKeys()).resolves.toEqual(new Map([["openai", "shared"]]));
    await expect(voiceCredentials.read("openai")).resolves.toBeUndefined();
  });

  it("leaves no voice copy behind once the shared key a failed sign-in kept is removed", async () => {
    const { service, voiceCredentials } = await createSignInService({ browser: "manual" });
    await service.saveVoiceKey("openai", "api-key");
    await service.startSignIn("openai");
    await expect(service.finishSignIn("openai", "http://127.0.0.1:1455/auth/callback?state=other")).rejects.toThrow();

    await expect(service.listVoiceKeys()).resolves.toEqual(new Map([["openai", "shared"]]));

    await service.removeVoiceKey("openai");

    await expect(service.getVoiceKey("openai")).resolves.toBeUndefined();
    await expect(voiceCredentials.read("openai")).resolves.toBeUndefined();
  });

  it("shows the page and takes the pasted address when the browser runs elsewhere", async () => {
    const { service, credentials, openExternal } = await createSignInService({ browser: "manual" });

    const started = await service.startSignIn("openai");

    expect(openExternal).not.toHaveBeenCalled();
    expect(started.providerSignIn).toEqual({ providerId: "openai", status: "waiting", signInUrl: AUTH_URL });
    const finished = await service.finishSignIn("openai", REDIRECT);
    expect(finished.providerSignIn).toBeNull();
    expect(finished.providers.find(({ id }) => id === "openai")?.credentialKind).toBe("subscription");
    await expect(credentials.read("openai")).resolves.toMatchObject({ type: "oauth" });
  });

  it("reports a failed sign-in and lets the person try again", async () => {
    const { service, credentials } = await createSignInService({ browser: "manual" });
    await service.startSignIn("openai");

    await expect(
      service.finishSignIn("openai", "http://127.0.0.1:1455/auth/callback?code=x&state=other"),
    ).rejects.toMatchObject({ code: "configuration_required", message: "OAuth state mismatch" });

    expect((await service.getView()).providerSignIn).toEqual({
      providerId: "openai",
      status: "failed",
      error: "OAuth state mismatch",
    });
    await expect(credentials.read("openai")).resolves.toBeUndefined();
    await expect(service.startSignIn("openai")).resolves.toMatchObject({
      providerSignIn: { status: "waiting", signInUrl: AUTH_URL },
    });
  });

  it("cancels a waiting sign-in without connecting", async () => {
    const { service, credentials } = await createSignInService();
    await service.startSignIn("openai");
    await expect(service.startSignIn("openai")).rejects.toMatchObject({ code: "invalid_request" });

    const view = await service.cancelSignIn("openai");

    expect(view.providerSignIn).toBeNull();
    await expect(credentials.read("openai")).resolves.toBeUndefined();
  });

  it("signs out through the runtime and clears a selection that used the sign-in", async () => {
    const { service, runtime, credentials, completeInBrowser } = await createSignInService();
    await service.startSignIn("openai");
    completeInBrowser();
    await waitForSignInToEnd(service);
    await service.save({ selection: { providerId: "openai", modelId: "openai-chat" } });

    const view = await service.removeCredential("openai");

    expect(runtime.logout).toHaveBeenCalledWith("openai");
    expect(view.selection).toBeNull();
    await expect(credentials.read("openai")).resolves.toBeUndefined();
  });

  it("does not accept a stored sign-in for a provider Wisp does not offer one for", async () => {
    const { service, credentials } = await createSignInService();
    await credentials.modify("anthropic", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }));

    await expect(
      service.save({ selection: { providerId: "anthropic", modelId: "anthropic-chat" } }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      service.validateConversationSelection({ providerId: "anthropic", modelId: "anthropic-chat" }),
    ).rejects.toMatchObject({ code: "configuration_required" });
  });
});

describe("ModelService with Claude Code", () => {
  async function createClaudeCodeService(initial: ClaudeCodeStatusView) {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-model-claude-code-"));
    directories.push(directory);
    let status = initial;
    const service = new ModelService({
      runtime: createRuntime() as unknown as ModelRuntimeLike,
      credentials: new EncryptedCredentialStore(path.join(directory, "credentials.enc.json"), new TestEncryption()),
      voiceCredentials: new EncryptedCredentialStore(
        path.join(directory, "voice-credentials.enc.json"),
        new TestEncryption(),
      ),
      settings: new AiSettingsStore(path.join(directory, "settings.json")),
      claudeCode: {
        current: () => status as never,
        refresh: async () => status as never,
      },
    });
    return { service, setStatus: (next: ClaudeCodeStatusView) => (status = next) };
  }

  const ready: ClaudeCodeStatusView = { state: "ready", version: "2.1.303", billing: "subscription", plan: "pro" };
  const sonnet = { providerId: CLAUDE_CODE_PROVIDER, modelId: "sonnet" };

  it("offers Claude Code's model aliases with its status", async () => {
    const { service } = await createClaudeCodeService(ready);

    const view = await service.getView();

    const provider = view.providers.find(({ id }) => id === CLAUDE_CODE_PROVIDER);
    expect(provider).toMatchObject({ name: "Claude Code", credentialConfigured: true });
    expect(provider?.models.map(({ id }) => id).sort()).toEqual(["default", "haiku", "opus", "sonnet"]);
    expect(provider?.models[0]?.thinkingLevels).not.toContain("minimal");
    expect(view.claudeCode).toEqual(ready);
  });

  it("selects a Claude Code model without a key once Claude Code is ready", async () => {
    const { service, setStatus } = await createClaudeCodeService({ state: "signed_out", version: "2.1.303" });

    await expect(service.save({ selection: sonnet })).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "Claude Code is not signed in. Run `claude auth login` on the server's computer.",
    });
    setStatus(ready);
    await expect(service.save({ selection: sonnet, apiKey: "sk" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.save({ selection: { ...sonnet, thinkingLevel: "high" } })).resolves.toMatchObject({
      selection: { ...sonnet, thinkingLevel: "high" },
    });
    await expect(service.getSelection()).resolves.toEqual({ ...sonnet, thinkingLevel: "high" });
    await expect(service.validateConversationSelection(sonnet)).resolves.toBeUndefined();
  });

  it("stops offering a saved Claude Code model while Claude Code cannot run", async () => {
    const { service, setStatus } = await createClaudeCodeService(ready);
    await service.save({ selection: sonnet });

    setStatus({ state: "outdated", version: "2.1.200", minimumVersion: "2.1.276" });

    await expect(service.getSelection()).resolves.toBeNull();
    const provider = (await service.getView()).providers.find(({ id }) => id === CLAUDE_CODE_PROVIDER);
    expect(provider?.credentialConfigured).toBe(false);
    await expect(service.validateConversationSelection(sonnet)).rejects.toMatchObject({
      code: "configuration_required",
      message: "Claude Code 2.1.200 is too old. Run `claude update` on the server's computer to get 2.1.276 or newer.",
    });
  });

  it("refuses unknown aliases and leaves Claude Code out without status support", async () => {
    const { service } = await createClaudeCodeService(ready);
    await expect(
      service.save({ selection: { providerId: CLAUDE_CODE_PROVIDER, modelId: "fable" } }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const { service: plain } = await createService();
    expect((await plain.getView()).providers.map(({ id }) => id)).not.toContain(CLAUDE_CODE_PROVIDER);
    await expect(plain.save({ selection: sonnet })).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
