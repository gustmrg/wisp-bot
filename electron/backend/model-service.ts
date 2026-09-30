import path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import type {
  AiSettingsView,
  ModelSelection,
  ModelSummary,
  ProviderSummary,
  SaveAiSettingsRequest,
} from "../../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import { AiSettingsStore } from "./ai-settings-store.js";
import { EncryptedCredentialStore, type EncryptionService } from "./encrypted-credential-store.js";

const MAX_API_KEY_LENGTH = 20_000;
const MODEL_REFRESH_TIMEOUT_MS = 10_000;

type ModelRefreshResult = Awaited<ReturnType<ModelRuntime["refresh"]>>;

export interface ModelRuntimeLike {
  getProviders(): ReturnType<ModelRuntime["getProviders"]>;
  getProvider(providerId: string): ReturnType<ModelRuntime["getProvider"]>;
  getModels(providerId?: string): ReturnType<ModelRuntime["getModels"]>;
  getModel(providerId: string, modelId: string): ReturnType<ModelRuntime["getModel"]>;
  getError(): string | undefined;
  hasConfiguredAuth(providerId: string): boolean;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  removeRuntimeApiKey(providerId: string): Promise<void>;
}

interface ModelServiceOptions {
  runtime: ModelRuntimeLike;
  settings: AiSettingsStore;
  credentials: EncryptedCredentialStore;
  /** The runtime's catalog refresh; absent for runtimes that cannot refresh. */
  refresh?: (options: { allowNetwork: boolean; signal: AbortSignal }) => Promise<ModelRefreshResult>;
}

export interface CreateModelServiceOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  /** Allow the runtime to use the network for model catalogs. Defaults to true. */
  allowModelNetwork?: boolean;
}

function describeRefreshFailure(result: ModelRefreshResult): string | null {
  const problems = [...result.errors].map(([providerId, error]) => `${providerId}: ${error.message}`);
  if (result.aborted) problems.push("the catalog refresh timed out");
  return problems.length > 0 ? problems.join("; ") : null;
}

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

export class ModelService {
  private readonly runtime: ModelRuntimeLike;
  private readonly settings: AiSettingsStore;
  private readonly credentials: EncryptedCredentialStore;
  private readonly refreshRuntime: ModelServiceOptions["refresh"];
  private catalogRefreshError: string | null = null;
  private networkRefreshError: string | null = null;
  private networkRefresh: AbortController | undefined;

  constructor(options: ModelServiceOptions) {
    this.runtime = options.runtime;
    this.settings = options.settings;
    this.credentials = options.credentials;
    this.refreshRuntime = options.refresh;
  }

  static async create(options: CreateModelServiceOptions): Promise<ModelService> {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const credentials = new EncryptedCredentialStore(
      path.join(options.dataDirectory, "credentials.enc.json"),
      options.encryption,
    );
    const runtime = await ModelRuntime.create({
      credentials,
      // A modelsPath must be set for the runtime to persist refreshed catalog data
      // at modelsStorePath; the file itself is optional and stays empty unless the
      // user defines custom models.
      modelsPath: path.join(options.dataDirectory, "models.json"),
      modelsStorePath: path.join(options.dataDirectory, "model-catalog.json"),
      allowModelNetwork: options.allowModelNetwork ?? true,
      refreshOnCreate: false,
    });
    const service = new ModelService({
      runtime,
      credentials,
      settings: new AiSettingsStore(path.join(options.dataDirectory, "ai-settings.json")),
      refresh: (refreshOptions) => runtime.refresh(refreshOptions),
    });
    // Restore saved credentials and cached catalog entries offline, so the app
    // is usable without waiting on the network. The availability pass that
    // populates hasConfiguredAuth() must complete here, not on a network signal
    // that may time out, or saved keys would look unconfigured.
    service.catalogRefreshError = describeRefreshFailure(await runtime.refresh({ allowNetwork: false }));
    return service;
  }

  /**
   * Updates model catalogs over the network, bounded by `timeoutMs`, and
   * reports failures in the settings view. Startup runs this in the background
   * after the window opens, on top of the offline catalog `create` loaded.
   */
  async refreshCatalog(timeoutMs = MODEL_REFRESH_TIMEOUT_MS): Promise<void> {
    if (!this.refreshRuntime) return;
    this.networkRefresh?.abort();
    const controller = new AbortController();
    this.networkRefresh = controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.refreshRuntime({ allowNetwork: true, signal: controller.signal });
      this.networkRefreshError = describeRefreshFailure(result);
    } finally {
      clearTimeout(timeout);
      if (this.networkRefresh === controller) this.networkRefresh = undefined;
    }
  }

  /** Stops an in-flight network refresh; used on shutdown. */
  dispose(): void {
    this.networkRefresh?.abort();
  }

  async getView(): Promise<AiSettingsView> {
    const credentialProviders = new Set((await this.credentials.list()).map(({ providerId }) => providerId));
    const providers: ProviderSummary[] = this.runtime
      .getProviders()
      .filter((provider) => Boolean(provider.auth.apiKey) && this.runtime.getModels(provider.id).length > 0)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        credentialConfigured: credentialProviders.has(provider.id),
        models: this.runtime
          .getModels(provider.id)
          .map<ModelSummary>((model) => ({
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            input: [...model.input],
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxTokens,
          }))
          .sort(compareByName),
      }))
      .filter((provider) => provider.models.length > 0)
      .sort(compareByName);

    const savedSelection = await this.settings.getSelection();
    const selection =
      savedSelection && this.isValidSelection(savedSelection) && credentialProviders.has(savedSelection.providerId)
        ? savedSelection
        : null;
    const errors = [this.catalogRefreshError, this.networkRefreshError, this.runtime.getError()].filter(
      (error): error is string => Boolean(error),
    );
    return {
      selection,
      secureStorageAvailable: this.credentials.isSecureStorageAvailable(),
      providers,
      catalogError: errors.length > 0 ? errors.join("\n") : null,
    };
  }

  async save(request: SaveAiSettingsRequest): Promise<AiSettingsView> {
    const { selection } = request;
    this.assertValidSelection(selection);

    const apiKey = request.apiKey?.trim();
    if (apiKey !== undefined && (!apiKey || apiKey.length > MAX_API_KEY_LENGTH)) {
      throw new WispBackendError("invalid_request", "Enter a valid API key.");
    }

    const existingCredential = await this.credentials.read(selection.providerId);
    if (!apiKey && existingCredential?.type !== "api_key") {
      throw new WispBackendError("invalid_configuration", "Add an API key before selecting this provider.");
    }

    if (apiKey) {
      if (!this.credentials.isSecureStorageAvailable()) {
        throw new WispBackendError(
          "secure_storage_unavailable",
          "Secure credential storage is unavailable on this device.",
        );
      }
      await this.runtime.setRuntimeApiKey(selection.providerId, apiKey);
      try {
        await this.credentials.setApiKey(selection.providerId, apiKey);
      } catch (error) {
        await this.runtime.removeRuntimeApiKey(selection.providerId).catch(() => undefined);
        throw error;
      }
    }
    await this.settings.setSelection(selection);
    return this.getView();
  }

  async removeCredential(providerId: string): Promise<AiSettingsView> {
    const provider = this.runtime.getProvider(providerId);
    if (!provider?.auth.apiKey) {
      throw new WispBackendError("invalid_request", "The provider is invalid.");
    }

    await this.runtime.removeRuntimeApiKey(providerId);
    await this.credentials.delete(providerId);
    const selection = await this.settings.getSelection();
    if (selection?.providerId === providerId) await this.settings.setSelection(null);
    return this.getView();
  }

  getModelRuntime(): ModelRuntimeLike {
    return this.runtime;
  }

  async getSelection(): Promise<ModelSelection | null> {
    const selection = await this.settings.getSelection();
    if (!selection || !this.isValidSelection(selection)) return null;
    const credential = await this.credentials.read(selection.providerId);
    return credential?.type === "api_key" ? selection : null;
  }

  async validateConversationSelection(selection: ModelSelection): Promise<void> {
    this.assertValidSelection(selection);
    const credential = await this.credentials.read(selection.providerId);
    if (credential?.type !== "api_key") {
      throw new WispBackendError(
        "configuration_required",
        "Configure an API key for this provider in AI Model settings.",
      );
    }
  }

  private isValidSelection(selection: ModelSelection): boolean {
    const provider = this.runtime.getProvider(selection.providerId);
    const model = this.runtime.getModel(selection.providerId, selection.modelId);
    const maxOutputTokens = selection.maxOutputTokens;
    return Boolean(
      provider?.auth.apiKey &&
        model &&
        (maxOutputTokens === undefined ||
          (Number.isSafeInteger(maxOutputTokens) &&
            maxOutputTokens >= 1 &&
            maxOutputTokens <= 1_000_000 &&
            maxOutputTokens <= model.maxTokens)),
    );
  }

  private assertValidSelection(selection: ModelSelection): void {
    if (!this.isValidSelection(selection)) {
      throw new WispBackendError("invalid_configuration", "The selected provider and model are not available.");
    }
  }
}
