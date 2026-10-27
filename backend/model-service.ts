import path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import {
  THINKING_LEVELS,
  type ThinkingLevel,
  type AiSettingsView,
  type SaveFallbackModelRequest,
  type AuxiliaryModelUnavailableReason,
  type AuxiliaryModelView,
  type AuxiliaryTask,
  type FallbackModelUnavailableReason,
  type FallbackModelView,
  type ModelSelection,
  type ModelSummary,
  type ProviderSignInView,
  type ProviderSummary,
  type SaveAiSettingsRequest,
  type WispFallback,
  wispFallbackChoice,
} from "../shared/contracts.js";
import { CLAUDE_CODE_PROVIDER, type ClaudeCodeStatusView } from "../shared/claude-code.js";
import { providerKind, type ProviderRuntime } from "../shared/provider-kinds.js";
import {
  MAX_CUSTOM_ENDPOINTS,
  type CustomEndpointModelsView,
  type CustomEndpointView,
  type DetectedEndpointsView,
  type LoadCustomEndpointModelsRequest,
  type SaveCustomEndpointRequest,
} from "../shared/custom-endpoints.js";
import { isVoiceProviderId, type VoiceCredentialSource } from "../shared/voice.js";
import { WispBackendError } from "./backend-error.js";
import { AiSettingsStore } from "./ai-settings-store.js";
import { EncryptedCredentialStore, type EncryptionService } from "./encrypted-credential-store.js";
import type { SignInBrowser } from "./oauth-redirect.js";
import {
  CustomEndpointStore,
  detectLocalEndpoints,
  fetchEndpointModels,
  newCustomEndpointId,
  piProviderConfig,
  sameOrigin,
  type FetchFunction,
  type StoredCustomEndpoint,
} from "./custom-endpoints.js";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER_NAME, claudeCodeModel } from "./claude-code/claude-code-models.js";
import { claudeCodeUnavailableMessage, type ClaudeCodeStatusService } from "./claude-code/claude-code-status.js";

type ClaudeCodeStatusSource = Pick<ClaudeCodeStatusService, "current" | "refresh">;

const MAX_API_KEY_LENGTH = 20_000;
const MODEL_REFRESH_TIMEOUT_MS = 10_000;
const MAX_SIGN_IN_ERROR_LENGTH = 300;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * Providers whose subscription sign-in Wisp offers. Pi has more OAuth flows,
 * but the others sign in as another vendor's own client, such as Claude Code,
 * which their terms do not allow for third-party apps (ADR 025).
 */
const SUBSCRIPTION_SIGN_IN_PROVIDERS: ReadonlySet<string> = new Set(["openai"]);

type ModelRefreshResult = Awaited<ReturnType<ModelRuntime["refresh"]>>;
type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type LoginOptions = NonNullable<Parameters<ModelRuntime["login"]>[3]>;

export interface ModelRuntimeLike {
  getProviders(): ReturnType<ModelRuntime["getProviders"]>;
  getProvider(providerId: string): ReturnType<ModelRuntime["getProvider"]>;
  getModels(providerId?: string): ReturnType<ModelRuntime["getModels"]>;
  getModel(providerId: string, modelId: string): ReturnType<ModelRuntime["getModel"]>;
  getError(): string | undefined;
  hasConfiguredAuth(providerId: string): boolean;
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
  removeRuntimeApiKey(providerId: string): Promise<void>;
  /** Runs the provider's interactive sign-in and stores the credential it returns. */
  login(providerId: string, type: "oauth", interaction: AuthInteraction, options?: LoginOptions): Promise<unknown>;
  /** Deletes the provider's stored credential. */
  logout(providerId: string): Promise<void>;
  /** Adds or replaces a provider of Wisp's own, such as a custom endpoint, beside the catalog's. */
  registerProvider(providerId: string, config: Parameters<ModelRuntime["registerProvider"]>[1]): void;
  unregisterProvider(providerId: string): void;
}

interface ModelServiceOptions {
  runtime: ModelRuntimeLike;
  settings: AiSettingsStore;
  credentials: EncryptedCredentialStore;
  /**
   * Keys for voice input alone, kept apart from `credentials` while a
   * provider's models use a subscription sign-in, since Pi keeps one
   * credential per provider.
   */
  voiceCredentials: EncryptedCredentialStore;
  /** The runtime's catalog refresh; absent for runtimes that cannot refresh. */
  refresh?: (options: { allowNetwork: boolean; signal: AbortSignal }) => Promise<ModelRefreshResult>;
  /** Opens the system browser on this computer for a subscription sign-in. */
  openExternal?: (url: string) => Promise<void>;
  /** Where the browser of a sign-in runs for the device that asked; defaults to this computer. */
  signInBrowser?: () => Promise<SignInBrowser>;
  /** Whether Claude Code can run Wisps; without it, the `claude-code` provider is not offered (ADR 026). */
  claudeCode?: ClaudeCodeStatusSource;
  /** The OpenAI-compatible endpoints the person added (ADR 031); without it, none can be added. */
  customEndpoints?: CustomEndpointStore;
  /** How endpoints' model lists are read; tests answer for them. */
  fetch?: FetchFunction;
  /** Where local model servers are looked for; tests point it away from real ones. */
  localEndpoints?: ReadonlyArray<{ name: string; baseUrl: string }>;
}

export interface CreateModelServiceOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  /** Allow the runtime to use the network for model catalogs. Defaults to true. */
  allowModelNetwork?: boolean;
  claudeCode?: ClaudeCodeStatusSource;
  openExternal?: (url: string) => Promise<void>;
  signInBrowser?: () => Promise<SignInBrowser>;
  fetch?: FetchFunction;
  localEndpoints?: ReadonlyArray<{ name: string; baseUrl: string }>;
}

/** A subscription sign-in waiting on the browser, or the last one that failed. */
interface ProviderSignIn {
  providerId: string;
  status: "waiting" | "failed";
  controller: AbortController;
  /** Settles when the sign-in stored its credential or failed. */
  done: Promise<void>;
  signInUrl?: string;
  /** Completes the flow with the pasted redirect address while it waits for one. */
  submitRedirect?: (redirectUrl: string) => void;
  cancelledByUser: boolean;
  error?: string;
}

function signInFailure(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : "The sign-in did not complete.";
  return message.length > MAX_SIGN_IN_ERROR_LENGTH ? `${message.slice(0, MAX_SIGN_IN_ERROR_LENGTH - 1)}…` : message;
}

function isSafeAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function describeRefreshFailure(result: ModelRefreshResult): string | null {
  const problems = [...result.errors].map(([providerId, error]) => `${providerId}: ${error.message}`);
  if (result.aborted) problems.push("the catalog refresh timed out");
  return problems.length > 0 ? problems.join("; ") : null;
}

type CatalogModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** A model as the checks here read it, whichever runtime offers it. */
type RuntimeModel = Pick<
  CatalogModel,
  "id" | "name" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens"
>;

/** What this service checks differently for each runtime. */
interface RuntimeRules {
  /** The model a selection names, when this server offers it. */
  model(selection: ModelSelection): RuntimeModel | undefined;
  /** Why the runtime cannot run Wisps now, in words the person can act on; undefined when it can. */
  unavailable(): Promise<string | undefined>;
}

/**
 * The thinking levels a model supports, as Pi's `getSupportedThinkingLevels`
 * reports them: "off" plus every level its thinking map does not disable,
 * with "xhigh" and "max" only when the map names them.
 */
export function supportedThinkingLevels(model: Pick<CatalogModel, "reasoning" | "thinkingLevelMap">): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function sameModel(left: ModelSelection, right: ModelSelection): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

function modelSummary(model: RuntimeModel): ModelSummary {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevels: supportedThinkingLevels(model),
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  };
}

export class ModelService {
  private readonly runtime: ModelRuntimeLike;
  private readonly settings: AiSettingsStore;
  private readonly credentials: EncryptedCredentialStore;
  private readonly voiceCredentials: EncryptedCredentialStore;
  private readonly refreshRuntime: ModelServiceOptions["refresh"];
  private catalogRefreshError: string | null = null;
  private networkRefreshError: string | null = null;
  private networkRefresh: AbortController | undefined;
  private readonly openExternal: ModelServiceOptions["openExternal"];
  private readonly signInBrowser: ModelServiceOptions["signInBrowser"];
  private signIn: ProviderSignIn | undefined;
  private readonly claudeCode: ClaudeCodeStatusSource | undefined;
  private readonly customEndpoints: CustomEndpointStore | undefined;
  private readonly fetch: FetchFunction | undefined;
  private readonly localEndpoints: ModelServiceOptions["localEndpoints"];
  private readonly runtimeRules: Record<ProviderRuntime, RuntimeRules> = {
    pi: {
      model: (selection) => this.catalogModel(selection),
      unavailable: async () => undefined,
    },
    "claude-code": {
      model: (selection) => (this.claudeCode ? claudeCodeModel(selection.modelId) : undefined),
      unavailable: () => this.claudeCodeUnavailable(),
    },
  };

  constructor(options: ModelServiceOptions) {
    this.runtime = options.runtime;
    this.settings = options.settings;
    this.credentials = options.credentials;
    this.voiceCredentials = options.voiceCredentials;
    this.refreshRuntime = options.refresh;
    this.openExternal = options.openExternal;
    this.signInBrowser = options.signInBrowser;
    this.claudeCode = options.claudeCode;
    this.customEndpoints = options.customEndpoints;
    this.fetch = options.fetch;
    this.localEndpoints = options.localEndpoints;
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
      voiceCredentials: new EncryptedCredentialStore(
        path.join(options.dataDirectory, "voice-credentials.enc.json"),
        options.encryption,
      ),
      settings: new AiSettingsStore(path.join(options.dataDirectory, "ai-settings.json")),
      refresh: (refreshOptions) => runtime.refresh(refreshOptions),
      ...(options.openExternal ? { openExternal: options.openExternal } : {}),
      ...(options.signInBrowser ? { signInBrowser: options.signInBrowser } : {}),
      ...(options.claudeCode ? { claudeCode: options.claudeCode } : {}),
      customEndpoints: new CustomEndpointStore(path.join(options.dataDirectory, "custom-endpoints.json")),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.localEndpoints ? { localEndpoints: options.localEndpoints } : {}),
    });
    await service.registerCustomEndpoints();
    // Restore saved credentials and cached catalog entries offline, so the app
    // is usable without waiting on the network. The availability pass that
    // populates hasConfiguredAuth() must complete here, not on a network signal
    // that may time out, or saved keys would look unconfigured.
    service.catalogRefreshError = describeRefreshFailure(await runtime.refresh({ allowNetwork: false }));
    return service;
  }

  /** Gives Pi the saved custom endpoints, before the availability pass that finds their keys. */
  async registerCustomEndpoints(): Promise<void> {
    for (const endpoint of (await this.customEndpoints?.list()) ?? []) {
      this.runtime.registerProvider(endpoint.id, piProviderConfig(endpoint));
    }
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

  /** Stops an in-flight network refresh and sign-in; used on shutdown. */
  dispose(): void {
    this.networkRefresh?.abort();
    this.signIn?.controller.abort();
  }

  async getView(): Promise<AiSettingsView> {
    const credentialTypes = new Map((await this.credentials.list()).map(({ providerId, type }) => [providerId, type]));
    const providers: ProviderSummary[] = this.runtime
      .getProviders()
      .filter((provider) => Boolean(provider.auth.apiKey) && this.runtime.getModels(provider.id).length > 0)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        // A custom endpoint without a key is called without one.
        credentialConfigured: providerKind(provider.id).credential === "optional" || credentialTypes.has(provider.id),
        ...(credentialTypes.has(provider.id)
          ? {
              credentialKind:
                credentialTypes.get(provider.id) === "oauth" ? ("subscription" as const) : ("api_key" as const),
            }
          : {}),
        ...(this.offersSubscriptionSignIn(provider.id)
          ? { subscriptionSignIn: { label: provider.auth.oauth?.loginLabel ?? `Sign in with ${provider.name}` } }
          : {}),
        models: this.runtime.getModels(provider.id).map(modelSummary).sort(compareByName),
      }))
      .filter((provider) => provider.models.length > 0)
      .sort(compareByName);

    const usableProviders = await this.usableProviders();
    const claudeCode = await this.claudeCodeStatus();
    if (claudeCode) {
      providers.push({
        id: CLAUDE_CODE_PROVIDER,
        name: CLAUDE_CODE_PROVIDER_NAME,
        credentialConfigured: claudeCode.state === "ready",
        models: CLAUDE_CODE_MODELS.map(modelSummary),
      });
      providers.sort(compareByName);
    }

    const savedSelection = await this.settings.getSelection();
    // Shown while Wisps can use its provider, which `credentialConfigured` reports for every kind.
    const selection =
      savedSelection &&
      this.isValidSelection(savedSelection) &&
      providers.find(({ id }) => id === savedSelection.providerId)?.credentialConfigured
        ? savedSelection
        : null;
    const errors = [this.catalogRefreshError, this.networkRefreshError, this.runtime.getError()].filter(
      (error): error is string => Boolean(error),
    );
    const auxiliary = await this.settings.getAuxiliary();
    return {
      selection,
      auxiliary: {
        imageUnderstanding: this.auxiliaryView(auxiliary.imageUnderstanding, usableProviders),
      },
      ...(await this.fallbackViews(usableProviders)),
      secureStorageAvailable: this.credentials.isSecureStorageAvailable(),
      providers,
      providerSignIn: this.signInView(),
      ...(claudeCode ? { claudeCode } : {}),
      ...(this.customEndpoints ? { customEndpoints: await this.customEndpointViews(credentialTypes) } : {}),
      catalogError: errors.length > 0 ? errors.join("\n") : null,
    };
  }

  async save(request: SaveAiSettingsRequest): Promise<AiSettingsView> {
    const { selection } = request;
    this.assertValidSelection(selection);
    this.assertSupportedThinkingLevel(selection);

    const kind = providerKind(selection.providerId);
    // A provider that signs in on its own never takes a key from Wisp.
    if (kind.credential === "external" && request.apiKey !== undefined) {
      throw new WispBackendError("invalid_request", "This provider signs in on its own and takes no API key.");
    }
    // A custom endpoint's key is set with the endpoint, so it stays with the address it was given for.
    if (kind.credential === "optional" && request.apiKey !== undefined) {
      throw new WispBackendError("invalid_request", "Set this endpoint's API key under Custom endpoints.");
    }
    await this.assertRuntimeAvailable(selection.providerId, "invalid_configuration");
    if (kind.credential !== "required") {
      await this.settings.setSelection(selection);
      return this.getView();
    }

    const apiKey = request.apiKey?.trim();
    if (apiKey !== undefined && (!apiKey || apiKey.length > MAX_API_KEY_LENGTH)) {
      throw new WispBackendError("invalid_request", "Enter a valid API key.");
    }

    const existingCredential = await this.credentials.read(selection.providerId);
    if (!apiKey && !this.isUsableCredential(selection.providerId, existingCredential)) {
      throw new WispBackendError(
        "invalid_configuration",
        this.offersSubscriptionSignIn(selection.providerId)
          ? "Add an API key or sign in before selecting this provider."
          : "Add an API key before selecting this provider.",
      );
    }

    if (apiKey) await this.storeApiKey(selection.providerId, apiKey);
    await this.settings.setSelection(selection);
    return this.getView();
  }

  /**
   * Chooses the model for an auxiliary task, or turns the task off with null.
   * The model must accept what the task sends it and its provider needs a
   * saved key; auxiliary tasks never take a key of their own.
   */
  async saveAuxiliary(task: AuxiliaryTask, selection: ModelSelection | null): Promise<AiSettingsView> {
    if (selection) {
      const reason = this.auxiliaryUnavailableReason(selection, await this.usableProviders());
      if (reason) {
        throw new WispBackendError(
          "invalid_configuration",
          reason === "missing_key"
            ? "Add an API key for this provider before choosing one of its models."
            : reason === "no_image_input"
              ? "This model does not accept images."
              : "The selected provider and model are not available.",
        );
      }
    }
    await this.settings.setAuxiliary(
      task,
      selection && { providerId: selection.providerId, modelId: selection.modelId },
    );
    return this.getView();
  }

  /** The model for an auxiliary task, or null when the task is off or its saved model cannot be used. */
  async getAuxiliaryModel(task: AuxiliaryTask): Promise<ModelSelection | null> {
    const selection = (await this.settings.getAuxiliary())[task];
    if (!selection) return null;
    return this.auxiliaryUnavailableReason(selection, await this.usableProviders()) ? null : selection;
  }

  /**
   * Saves the global fallback models in order, or turns them off. Each
   * provider needs a saved key; a fallback never takes a key of its own. A
   * request from a client before the list names one model, which replaces
   * the first fallback and keeps the others.
   */
  async saveFallback(request: SaveFallbackModelRequest): Promise<AiSettingsView> {
    const current = await this.settings.getFallbacks();
    const selections = request.selections ?? (request.selection ? [request.selection, ...current.slice(1)] : []);
    const usableProviders = await this.usableProviders();
    // Only a model the person adds must be usable now; one already saved may wait for its key to return.
    for (const selection of selections) {
      if (current.some((saved) => sameModel(saved, selection))) continue;
      this.assertUsableFallbackFor(selection, usableProviders);
    }
    await this.settings.setFallbacks(selections);
    return this.getView();
  }

  /** Checks a fallback a person is choosing: a catalog model whose provider has a saved key. */
  async assertUsableFallback(selection: ModelSelection): Promise<void> {
    this.assertUsableFallbackFor(selection, await this.usableProviders());
  }

  private assertUsableFallbackFor(selection: ModelSelection, usableProviders: ReadonlySet<string>): void {
    const reason = this.fallbackUnavailableReason(selection, usableProviders);
    if (reason) {
      throw new WispBackendError(
        "invalid_configuration",
        reason === "missing_key"
          ? "Add an API key for this provider before choosing one of its models."
          : "The selected provider and model are not available.",
      );
    }
  }

  /**
   * The models a Wisp answers with when its own fails, in the order they are
   * tried: the global list or its own model. Models that cannot be used now
   * and the Wisp's own model are left out, so the list may be empty.
   */
  async getFallbackModels(modelOverride: ModelSelection | null, saved: WispFallback | null): Promise<ModelSelection[]> {
    const choice = wispFallbackChoice(modelOverride, saved);
    if (choice === "off") return [];
    const selections = choice === "global" ? await this.settings.getFallbacks() : [choice];
    const usableProviders = await this.usableProviders();
    const primary = modelOverride ?? (await this.settings.getSelection());
    return selections
      .filter((selection) => !this.fallbackUnavailableReason(selection, usableProviders))
      .filter((selection) => !primary || !sameModel(primary, selection))
      .map(({ providerId, modelId }) => ({ providerId, modelId }));
  }

  /**
   * Saves a provider key for voice input, which calls the provider directly.
   * The key is the provider's own, shared with its chat models, unless they
   * use a subscription sign-in: then it is kept for voice input alone, so it
   * does not replace the sign-in.
   */
  async saveVoiceKey(providerId: string, value: string): Promise<void> {
    const apiKey = value.trim();
    if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) {
      throw new WispBackendError("invalid_request", "Enter a valid API key.");
    }
    if ((await this.credentials.read(providerId))?.type !== "oauth") {
      await this.storeApiKey(providerId, apiKey);
      return;
    }
    this.assertSecureStorage();
    await this.voiceCredentials.setApiKey(providerId, apiKey);
  }

  /** The key voice input uses for a provider: its shared key first, then one kept for voice alone. */
  async getVoiceKey(providerId: string): Promise<string | undefined> {
    const shared = await this.credentials.read(providerId);
    if (shared?.type === "api_key" && shared.key) return shared.key;
    const own = await this.voiceCredentials.read(providerId);
    return own?.type === "api_key" && own.key ? own.key : undefined;
  }

  /** Providers with a key voice input can use, and where it is saved; a subscription sign-in does not count. */
  async listVoiceKeys(): Promise<ReadonlyMap<string, VoiceCredentialSource>> {
    const keys = new Map<string, VoiceCredentialSource>();
    for (const { providerId, type } of await this.voiceCredentials.list()) {
      if (type === "api_key") keys.set(providerId, "voice");
    }
    for (const { providerId, type } of await this.credentials.list()) {
      if (type === "api_key") keys.set(providerId, "shared");
    }
    return keys;
  }

  /**
   * Removes the key voice input uses for a provider. A shared key is removed
   * for its chat models too, as in AI Model settings; a subscription sign-in
   * is never touched.
   */
  async removeVoiceKey(providerId: string): Promise<void> {
    if ((await this.listVoiceKeys()).get(providerId) === "shared") await this.removeCredential(providerId);
    else await this.voiceCredentials.delete(providerId);
  }

  async listCredentialProviders(): Promise<ReadonlySet<string>> {
    return new Set((await this.credentials.list()).map(({ providerId }) => providerId));
  }

  /** Providers Wisps can use without more setup: a saved credential, or a kind that needs none. */
  private async usableProviders(): Promise<ReadonlySet<string>> {
    const providers = new Set(await this.listCredentialProviders());
    for (const { id } of this.runtime.getProviders()) {
      if (providerKind(id).credential === "optional") providers.add(id);
    }
    return providers;
  }

  isSecureStorageAvailable(): boolean {
    return this.credentials.isSecureStorageAvailable();
  }

  private assertSecureStorage(): void {
    if (!this.credentials.isSecureStorageAvailable()) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Secure credential storage is unavailable on this device.",
      );
    }
  }

  /**
   * Copies the provider's shared key to the keys kept for voice input before a
   * sign-in replaces it, so voice input keeps working. Copied before the
   * sign-in starts, so a failure here stops it before anything changed rather
   * than failing a sign-in that already replaced the key. Voice input reads
   * the shared key first, so a copy left by a sign-in that failed changes
   * nothing, and removing the shared key removes it.
   */
  private async keepKeyForVoice(providerId: string): Promise<void> {
    if (!isVoiceProviderId(providerId)) return;
    const shared = await this.credentials.read(providerId);
    if (shared?.type === "api_key" && shared.key) await this.voiceCredentials.setApiKey(providerId, shared.key);
  }

  private async storeApiKey(providerId: string, apiKey: string): Promise<void> {
    this.assertSecureStorage();
    // A key settles the provider's credential, so an earlier failed sign-in no longer matters.
    if (this.signIn?.status === "failed" && this.signIn.providerId === providerId) this.signIn = undefined;
    await this.runtime.setRuntimeApiKey(providerId, apiKey);
    try {
      await this.credentials.setApiKey(providerId, apiKey);
    } catch (error) {
      await this.runtime.removeRuntimeApiKey(providerId).catch(() => undefined);
      throw error;
    }
    // Voice input now uses the shared key, so one kept for voice alone would only go stale.
    await this.voiceCredentials.delete(providerId);
  }

  async removeCredential(providerId: string): Promise<AiSettingsView> {
    const provider = this.runtime.getProvider(providerId);
    if (!provider?.auth.apiKey) {
      throw new WispBackendError("invalid_request", "The provider is invalid.");
    }
    if (providerKind(providerId).credential === "optional") {
      throw new WispBackendError("invalid_request", "Remove this endpoint's API key under Custom endpoints.");
    }

    const credential = await this.credentials.read(providerId);
    await this.runtime.removeRuntimeApiKey(providerId);
    // Signing out goes through the runtime, so it stops using the cached sign-in at once.
    // A key kept for voice input stays; removing the shared key removes any copy of it.
    if (credential?.type === "oauth") await this.runtime.logout(providerId);
    else {
      await this.credentials.delete(providerId);
      await this.voiceCredentials.delete(providerId);
    }
    const selection = await this.settings.getSelection();
    if (selection?.providerId === providerId) await this.settings.setSelection(null);
    // Auxiliary and fallback selections stay saved and show as unavailable until a key returns.
    return this.getView();
  }

  /**
   * Starts a subscription sign-in in the browser and returns once the browser
   * has its page; the sign-in itself completes in the background, and the view
   * reports it. The browser runs on this computer for a local caller, and the
   * provider's redirect reaches the runtime's own listener here. Elsewhere the
   * view shows the page, and the person pastes the address the browser lands
   * on into finishSignIn: the provider's redirect address is fixed to this
   * computer's loopback, so a relay on another computer cannot receive it.
   * Signing in replaces a saved API key for the provider's models; voice
   * input keeps using it.
   */
  async startSignIn(providerId: string): Promise<AiSettingsView> {
    if (!this.offersSubscriptionSignIn(providerId)) {
      throw new WispBackendError("invalid_request", "This provider does not offer a subscription sign-in.");
    }
    if (this.signIn?.status === "waiting") {
      throw new WispBackendError("invalid_request", "A provider sign-in is already in progress.");
    }
    this.assertSecureStorage();
    const signIn: ProviderSignIn = {
      providerId,
      status: "waiting",
      controller: new AbortController(),
      done: Promise.resolve(),
      cancelledByUser: false,
    };
    // Taken before anything is awaited, so a second request is refused rather than racing this one.
    this.signIn = signIn;
    let browser: SignInBrowser;
    let installationId: string;
    try {
      browser = (await this.signInBrowser?.()) ?? { kind: "local" };
      if (browser.kind === "relay") browser.relay.close();
      installationId = await this.settings.getInstallationId();
      await this.keepKeyForVoice(providerId);
      signIn.controller.signal.throwIfAborted();
    } catch (error) {
      if (this.signIn === signIn) this.signIn = undefined;
      if (signIn.cancelledByUser) throw new WispBackendError("aborted", "The sign-in was cancelled.");
      throw error;
    }

    let pageReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      pageReady = resolve;
    });
    const showPage = (url: string): void => {
      signIn.signInUrl = url;
    };
    const interaction: AuthInteraction = {
      signal: signIn.controller.signal,
      notify: (event) => {
        if (event.type !== "auth_url") return;
        if (!isSafeAuthorizationUrl(event.url)) {
          signIn.controller.abort(new Error("The provider returned an unsafe sign-in address."));
          return;
        }
        if (browser.kind === "local" && this.openExternal) {
          // When no browser opens here after all, the person can still open the page by hand.
          void this.openExternal(event.url).catch(() => showPage(event.url));
        } else showPage(event.url);
        pageReady();
      },
      prompt: (prompt) => {
        if (prompt.type !== "manual_code") return Promise.reject(new Error("This sign-in step is not supported."));
        return new Promise<string>((resolve, reject) => {
          const signal = prompt.signal ?? signIn.controller.signal;
          if (signal.aborted) {
            reject(new Error("The sign-in was cancelled."));
            return;
          }
          signIn.submitRedirect = resolve;
          signal.addEventListener(
            "abort",
            () => {
              if (signIn.submitRedirect === resolve) delete signIn.submitRedirect;
              reject(new Error("The sign-in was cancelled."));
            },
            { once: true },
          );
        });
      },
    };

    // The provider's flow waits on the browser for as long as it takes.
    const timeout = setTimeout(
      () => signIn.controller.abort(new Error("The sign-in timed out. Try again.")),
      SIGN_IN_TIMEOUT_MS,
    );
    signIn.controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    signIn.done = this.runtime
      .login(providerId, "oauth", interaction, { getDeviceId: () => installationId })
      // A key saved in this session would still win over the sign-in.
      .then(() => this.runtime.removeRuntimeApiKey(providerId))
      .then(
        () => {
          clearTimeout(timeout);
          if (this.signIn === signIn) this.signIn = undefined;
        },
        (error: unknown) => {
          clearTimeout(timeout);
          if (this.signIn !== signIn) return;
          if (signIn.cancelledByUser) {
            this.signIn = undefined;
            return;
          }
          signIn.status = "failed";
          signIn.error = signInFailure(signIn.controller.signal.reason ?? error);
          delete signIn.signInUrl;
          delete signIn.submitRedirect;
        },
      );
    await Promise.race([ready, signIn.done]);
    if (signIn.error) throw new WispBackendError("configuration_required", signIn.error);
    return this.getView();
  }

  /** Ends a waiting sign-in without connecting. */
  async cancelSignIn(providerId: string): Promise<AiSettingsView> {
    const signIn = this.signIn;
    if (!signIn || signIn.providerId !== providerId) {
      throw new WispBackendError("not_found", "No sign-in is in progress for this provider.");
    }
    if (signIn.status === "failed") this.signIn = undefined;
    else {
      signIn.cancelledByUser = true;
      signIn.controller.abort();
      await signIn.done;
    }
    return this.getView();
  }

  /** Completes a waiting sign-in with the address its browser was sent to, and waits for the result. */
  async finishSignIn(providerId: string, redirectUrl: string): Promise<AiSettingsView> {
    const signIn = this.signIn;
    if (!signIn || signIn.providerId !== providerId || signIn.status !== "waiting" || !signIn.submitRedirect) {
      throw new WispBackendError("not_found", "No sign-in is waiting for this provider.");
    }
    try {
      new URL(redirectUrl);
    } catch {
      throw new WispBackendError("invalid_request", "That is not the address the sign-in sent you to.");
    }
    signIn.submitRedirect(redirectUrl);
    await signIn.done;
    if (signIn.error) throw new WispBackendError("configuration_required", signIn.error);
    return this.getView();
  }

  /**
   * Adds an endpoint, or changes one, and gives its models to Pi at once. A
   * saved key stays with the address it was given for: moving the endpoint
   * to another origin takes the key again, or its removal.
   */
  async saveCustomEndpoint(request: SaveCustomEndpointRequest): Promise<AiSettingsView> {
    const store = this.requireCustomEndpoints();
    const endpoints = await store.list();
    const index = request.id === undefined ? -1 : endpoints.findIndex(({ id }) => id === request.id);
    if (request.id !== undefined && index < 0) {
      throw new WispBackendError("not_found", "That custom endpoint no longer exists.");
    }
    if (index < 0 && endpoints.length >= MAX_CUSTOM_ENDPOINTS) {
      throw new WispBackendError("invalid_request", `Add at most ${MAX_CUSTOM_ENDPOINTS} custom endpoints.`);
    }
    const apiKey = request.apiKey?.trim();
    if (request.apiKey !== undefined && !apiKey)
      throw new WispBackendError("invalid_request", "Enter a valid API key.");
    if (apiKey && request.removeKey) {
      throw new WispBackendError("invalid_request", "Enter a new API key or remove the saved one, not both.");
    }
    if (apiKey) this.assertSecureStorage();

    const previous = endpoints[index];
    const id = previous?.id ?? newCustomEndpointId();
    const keySaved = previous ? Boolean(await this.credentials.read(id)) : false;
    if (previous && keySaved && !apiKey && !request.removeKey && !sameOrigin(previous.baseUrl, request.baseUrl)) {
      throw new WispBackendError(
        "invalid_request",
        "Enter the API key again, or remove it, to use this endpoint at another address.",
      );
    }

    const endpoint: StoredCustomEndpoint = {
      id,
      name: request.name,
      baseUrl: request.baseUrl,
      models: [...request.models],
    };
    await store.save(
      index < 0
        ? [...endpoints, endpoint]
        : endpoints.map((saved, position) => (position === index ? endpoint : saved)),
    );
    // Registering again only replaces what it names, so the previous registration goes first.
    if (previous) this.runtime.unregisterProvider(id);
    this.runtime.registerProvider(id, piProviderConfig(endpoint));
    if (apiKey) await this.storeApiKey(id, apiKey);
    else if (request.removeKey) await this.removeEndpointKey(id);
    return this.getView();
  }

  /** Removes an endpoint and its key. Wisps, fallbacks, and image models that chose one of its models keep the choice, shown as unavailable. */
  async removeCustomEndpoint(id: string): Promise<AiSettingsView> {
    const store = this.requireCustomEndpoints();
    const endpoints = await store.list();
    if (!endpoints.some((endpoint) => endpoint.id === id)) {
      throw new WispBackendError("not_found", "That custom endpoint no longer exists.");
    }
    await store.save(endpoints.filter((endpoint) => endpoint.id !== id));
    this.runtime.unregisterProvider(id);
    await this.removeEndpointKey(id);
    const selection = await this.settings.getSelection();
    if (selection?.providerId === id) await this.settings.setSelection(null);
    return this.getView();
  }

  /** The models an endpoint lists, with the key typed into the form, or a saved endpoint's key at its own address only. */
  async loadCustomEndpointModels(request: LoadCustomEndpointModelsRequest): Promise<CustomEndpointModelsView> {
    const store = this.requireCustomEndpoints();
    let apiKey = request.apiKey?.trim() || undefined;
    if (!apiKey && request.id !== undefined) {
      const saved = (await store.list()).find(({ id }) => id === request.id);
      if (saved && sameOrigin(saved.baseUrl, request.baseUrl)) {
        const credential = await this.credentials.read(saved.id);
        if (credential?.type === "api_key" && credential.key) apiKey = credential.key;
      }
    }
    return { models: await fetchEndpointModels(request.baseUrl, apiKey, this.fetch ? { fetch: this.fetch } : {}) };
  }

  /** Local model servers answering on this computer at their usual addresses, asked without a key. */
  async detectLocalEndpoints(): Promise<DetectedEndpointsView> {
    this.requireCustomEndpoints();
    return {
      endpoints: await detectLocalEndpoints({
        ...(this.fetch ? { fetch: this.fetch } : {}),
        ...(this.localEndpoints ? { candidates: this.localEndpoints } : {}),
      }),
    };
  }

  private requireCustomEndpoints(): CustomEndpointStore {
    if (!this.customEndpoints) throw new WispBackendError("unsupported", "Custom endpoints are not available here.");
    return this.customEndpoints;
  }

  private async removeEndpointKey(id: string): Promise<void> {
    await this.runtime.removeRuntimeApiKey(id);
    await this.credentials.delete(id);
  }

  private async customEndpointViews(credentialTypes: ReadonlyMap<string, string>): Promise<CustomEndpointView[]> {
    return ((await this.customEndpoints?.list()) ?? []).map(({ id, name, baseUrl, models }) => ({
      id,
      name,
      baseUrl,
      keySaved: credentialTypes.has(id),
      models,
    }));
  }

  getModelRuntime(): ModelRuntimeLike {
    return this.runtime;
  }

  async getSelection(): Promise<ModelSelection | null> {
    const selection = await this.settings.getSelection();
    if (!selection || !this.isValidSelection(selection)) return null;
    if (await this.runtimeUnavailable(selection.providerId)) return null;
    return (await this.hasUsableCredential(selection.providerId)) ? selection : null;
  }

  async validateConversationSelection(selection: ModelSelection): Promise<void> {
    this.assertValidSelection(selection);
    await this.assertRuntimeAvailable(selection.providerId, "configuration_required");
    if (!(await this.hasUsableCredential(selection.providerId))) {
      throw new WispBackendError(
        "configuration_required",
        "Configure an API key for this provider in AI Model settings.",
      );
    }
  }

  private offersSubscriptionSignIn(providerId: string): boolean {
    const provider = this.runtime.getProvider(providerId);
    return SUBSCRIPTION_SIGN_IN_PROVIDERS.has(providerId) && provider?.auth.oauth?.isSubscription === true;
  }

  /** Whether Wisp holds what the provider needs from it: nothing, for one that signs in on its own or needs no key. */
  private async hasUsableCredential(providerId: string): Promise<boolean> {
    if (providerKind(providerId).credential !== "required") return true;
    return this.isUsableCredential(providerId, await this.credentials.read(providerId));
  }

  /** An API key, or a sign-in for a provider whose sign-in Wisp offers. */
  private isUsableCredential(
    providerId: string,
    credential: Awaited<ReturnType<EncryptedCredentialStore["read"]>>,
  ): boolean {
    if (credential?.type === "api_key") return true;
    return credential?.type === "oauth" && this.offersSubscriptionSignIn(providerId);
  }

  private signInView(): ProviderSignInView | null {
    const signIn = this.signIn;
    if (!signIn) return null;
    return {
      providerId: signIn.providerId,
      status: signIn.status,
      ...(signIn.signInUrl ? { signInUrl: signIn.signInUrl } : {}),
      ...(signIn.error ? { error: signIn.error } : {}),
    };
  }

  private auxiliaryView(selection: ModelSelection | null, usableProviders: ReadonlySet<string>): AuxiliaryModelView {
    return {
      selection,
      unavailable: selection ? this.auxiliaryUnavailableReason(selection, usableProviders) : null,
    };
  }

  /** The first global fallback, as clients before the list read it, and the whole list. */
  private async fallbackViews(
    usableProviders: ReadonlySet<string>,
  ): Promise<Pick<AiSettingsView, "fallback" | "fallbacks">> {
    const fallbacks = (await this.settings.getFallbacks()).map((selection) =>
      this.fallbackView(selection, usableProviders),
    );
    return { fallback: fallbacks[0] ?? this.fallbackView(null, usableProviders), fallbacks };
  }

  private fallbackView(selection: ModelSelection | null, usableProviders: ReadonlySet<string>): FallbackModelView {
    return {
      selection,
      unavailable: selection ? this.fallbackUnavailableReason(selection, usableProviders) : null,
    };
  }

  private fallbackUnavailableReason(
    selection: ModelSelection,
    usableProviders: ReadonlySet<string>,
  ): FallbackModelUnavailableReason | null {
    if (!this.catalogModel(selection)) return "model_unavailable";
    return usableProviders.has(selection.providerId) ? null : "missing_key";
  }

  /** The catalog model a selection names, from a provider that takes API keys. */
  private catalogModel(selection: ModelSelection): CatalogModel | undefined {
    return this.runtime.getProvider(selection.providerId)?.auth.apiKey
      ? this.runtime.getModel(selection.providerId, selection.modelId)
      : undefined;
  }

  private auxiliaryUnavailableReason(
    selection: ModelSelection,
    usableProviders: ReadonlySet<string>,
  ): AuxiliaryModelUnavailableReason | null {
    const model = this.catalogModel(selection);
    if (!model) return "model_unavailable";
    if (!model.input.includes("image")) return "no_image_input";
    return usableProviders.has(selection.providerId) ? null : "missing_key";
  }

  /** The latest Claude Code status, checking again when it is stale; undefined without Claude Code support. */
  private async claudeCodeStatus(): Promise<ClaudeCodeStatusView | undefined> {
    if (!this.claudeCode) return undefined;
    try {
      return await this.claudeCode.refresh();
    } catch {
      return this.claudeCode.current() ?? { state: "checking" };
    }
  }

  private async claudeCodeUnavailable(): Promise<string | undefined> {
    const status = await this.claudeCodeStatus();
    return status ? claudeCodeUnavailableMessage(status) : "Claude Code is not available on this server.";
  }

  /** Why the runtime of a provider cannot run Wisps now; undefined when it can. */
  private runtimeUnavailable(providerId: string): Promise<string | undefined> {
    return this.runtimeRules[providerKind(providerId).runtime].unavailable();
  }

  private async assertRuntimeAvailable(
    providerId: string,
    code: "invalid_configuration" | "configuration_required",
  ): Promise<void> {
    const unavailable = await this.runtimeUnavailable(providerId);
    if (unavailable) throw new WispBackendError(code, unavailable);
  }

  private selectionModel(selection: ModelSelection): RuntimeModel | undefined {
    return this.runtimeRules[providerKind(selection.providerId).runtime].model(selection);
  }

  private isValidSelection(selection: ModelSelection): boolean {
    const model = this.selectionModel(selection);
    if (!model) return false;
    const maxOutputTokens = selection.maxOutputTokens;
    // A runtime that manages its own output limit ignores a saved one.
    if (maxOutputTokens === undefined || providerKind(selection.providerId).outputLimit === "runtime") return true;
    return (
      Number.isSafeInteger(maxOutputTokens) &&
      maxOutputTokens >= 1 &&
      maxOutputTokens <= 1_000_000 &&
      maxOutputTokens <= model.maxTokens
    );
  }

  private assertValidSelection(selection: ModelSelection): void {
    if (!this.isValidSelection(selection)) {
      throw new WispBackendError("invalid_configuration", "The selected provider and model are not available.");
    }
  }

  /**
   * Checks a newly chosen thinking level. The default, "off", is always
   * accepted, and a saved level the catalog later drops is not rejected: Pi
   * clamps either to the nearest level the model supports.
   */
  assertSupportedThinkingLevel(selection: ModelSelection): void {
    const level = selection.thinkingLevel;
    if (!level || level === "off") return;
    const model = this.selectionModel(selection);
    if (model && !supportedThinkingLevels(model).includes(level)) {
      throw new WispBackendError("invalid_configuration", "The selected model does not support this reasoning level.");
    }
  }
}
