import path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import {
  THINKING_LEVELS,
  type ThinkingLevel,
  type AiSettingsView,
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
import { WispBackendError } from "./backend-error.js";
import { AiSettingsStore } from "./ai-settings-store.js";
import { EncryptedCredentialStore, type EncryptionService } from "./encrypted-credential-store.js";
import type { SignInBrowser } from "./oauth-redirect.js";
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
}

interface ModelServiceOptions {
  runtime: ModelRuntimeLike;
  settings: AiSettingsStore;
  credentials: EncryptedCredentialStore;
  /** The runtime's catalog refresh; absent for runtimes that cannot refresh. */
  refresh?: (options: { allowNetwork: boolean; signal: AbortSignal }) => Promise<ModelRefreshResult>;
  /** Opens the system browser on this computer for a subscription sign-in. */
  openExternal?: (url: string) => Promise<void>;
  /** Where the browser of a sign-in runs for the device that asked; defaults to this computer. */
  signInBrowser?: () => Promise<SignInBrowser>;
  /** Whether Claude Code can run Wisps; without it, the `claude-code` provider is not offered (ADR 026). */
  claudeCode?: ClaudeCodeStatusSource;
}

export interface CreateModelServiceOptions {
  dataDirectory: string;
  encryption: EncryptionService;
  /** Allow the runtime to use the network for model catalogs. Defaults to true. */
  allowModelNetwork?: boolean;
  claudeCode?: ClaudeCodeStatusSource;
  openExternal?: (url: string) => Promise<void>;
  signInBrowser?: () => Promise<SignInBrowser>;
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

export class ModelService {
  private readonly runtime: ModelRuntimeLike;
  private readonly settings: AiSettingsStore;
  private readonly credentials: EncryptedCredentialStore;
  private readonly refreshRuntime: ModelServiceOptions["refresh"];
  private catalogRefreshError: string | null = null;
  private networkRefreshError: string | null = null;
  private networkRefresh: AbortController | undefined;
  private readonly openExternal: ModelServiceOptions["openExternal"];
  private readonly signInBrowser: ModelServiceOptions["signInBrowser"];
  private signIn: ProviderSignIn | undefined;
  private readonly claudeCode: ClaudeCodeStatusSource | undefined;

  constructor(options: ModelServiceOptions) {
    this.runtime = options.runtime;
    this.settings = options.settings;
    this.credentials = options.credentials;
    this.refreshRuntime = options.refresh;
    this.openExternal = options.openExternal;
    this.signInBrowser = options.signInBrowser;
    this.claudeCode = options.claudeCode;
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
      ...(options.openExternal ? { openExternal: options.openExternal } : {}),
      ...(options.signInBrowser ? { signInBrowser: options.signInBrowser } : {}),
      ...(options.claudeCode ? { claudeCode: options.claudeCode } : {}),
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
        credentialConfigured: credentialTypes.has(provider.id),
        ...(credentialTypes.has(provider.id)
          ? {
              credentialKind:
                credentialTypes.get(provider.id) === "oauth" ? ("subscription" as const) : ("api_key" as const),
            }
          : {}),
        ...(this.offersSubscriptionSignIn(provider.id)
          ? { subscriptionSignIn: { label: provider.auth.oauth?.loginLabel ?? `Sign in with ${provider.name}` } }
          : {}),
        models: this.runtime
          .getModels(provider.id)
          .map<ModelSummary>((model) => ({
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            thinkingLevels: supportedThinkingLevels(model),
            input: [...model.input],
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxTokens,
          }))
          .sort(compareByName),
      }))
      .filter((provider) => provider.models.length > 0)
      .sort(compareByName);

    const credentialProviders: ReadonlySet<string> = new Set(credentialTypes.keys());
    const claudeCode = await this.claudeCodeStatus();
    if (claudeCode) {
      providers.push({
        id: CLAUDE_CODE_PROVIDER,
        name: CLAUDE_CODE_PROVIDER_NAME,
        credentialConfigured: claudeCode.state === "ready",
        models: CLAUDE_CODE_MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          thinkingLevels: supportedThinkingLevels(model),
          input: [...model.input],
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxTokens,
        })),
      });
      providers.sort(compareByName);
    }

    const savedSelection = await this.settings.getSelection();
    const selection =
      savedSelection &&
      this.isValidSelection(savedSelection) &&
      (savedSelection.providerId === CLAUDE_CODE_PROVIDER
        ? claudeCode?.state === "ready"
        : credentialProviders.has(savedSelection.providerId))
        ? savedSelection
        : null;
    const errors = [this.catalogRefreshError, this.networkRefreshError, this.runtime.getError()].filter(
      (error): error is string => Boolean(error),
    );
    const auxiliary = await this.settings.getAuxiliary();
    return {
      selection,
      auxiliary: {
        imageUnderstanding: this.auxiliaryView(auxiliary.imageUnderstanding, credentialProviders),
      },
      fallback: this.fallbackView(await this.settings.getFallback(), credentialProviders),
      secureStorageAvailable: this.credentials.isSecureStorageAvailable(),
      providers,
      providerSignIn: this.signInView(),
      ...(claudeCode ? { claudeCode } : {}),
      catalogError: errors.length > 0 ? errors.join("\n") : null,
    };
  }

  async save(request: SaveAiSettingsRequest): Promise<AiSettingsView> {
    const { selection } = request;
    this.assertValidSelection(selection);
    this.assertSupportedThinkingLevel(selection);

    if (selection.providerId === CLAUDE_CODE_PROVIDER) {
      // Claude Code signs in on its own; Wisp never takes a key for it.
      if (request.apiKey !== undefined) throw new WispBackendError("invalid_request", "Claude Code takes no API key.");
      await this.assertClaudeCodeReady("invalid_configuration");
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
      const reason = this.auxiliaryUnavailableReason(selection, await this.listCredentialProviders());
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
    return this.auxiliaryUnavailableReason(selection, await this.listCredentialProviders()) ? null : selection;
  }

  /**
   * Chooses the global fallback model, or turns it off with null. Its provider
   * needs a saved key; a fallback never takes a key of its own.
   */
  async saveFallback(selection: ModelSelection | null): Promise<AiSettingsView> {
    if (selection) await this.assertUsableFallback(selection);
    await this.settings.setFallback(selection);
    return this.getView();
  }

  /** Checks a fallback a person is choosing: a catalog model whose provider has a saved key. */
  async assertUsableFallback(selection: ModelSelection): Promise<void> {
    const reason = this.fallbackUnavailableReason(selection, await this.listCredentialProviders());
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
   * The model a Wisp answers with when its own fails for good, or null when it
   * has none, its saved model cannot be used, or it is the model that failed.
   */
  async getFallbackModel(
    modelOverride: ModelSelection | null,
    saved: WispFallback | null,
  ): Promise<ModelSelection | null> {
    const choice = wispFallbackChoice(modelOverride, saved);
    if (choice === "off") return null;
    const selection = choice === "global" ? await this.settings.getFallback() : choice;
    if (!selection || this.fallbackUnavailableReason(selection, await this.listCredentialProviders())) return null;
    const primary = modelOverride ?? (await this.settings.getSelection());
    return primary && sameModel(primary, selection)
      ? null
      : { providerId: selection.providerId, modelId: selection.modelId };
  }

  /**
   * Saves a provider key outside of a model selection, for features such as
   * voice input that call the provider directly. Chat models of the same
   * provider can use the key too.
   */
  async setApiKey(providerId: string, value: string): Promise<void> {
    const apiKey = value.trim();
    if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) {
      throw new WispBackendError("invalid_request", "Enter a valid API key.");
    }
    await this.storeApiKey(providerId, apiKey);
  }

  /** The saved key for a provider, or undefined when none is saved. */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const credential = await this.credentials.read(providerId);
    return credential?.type === "api_key" && credential.key ? credential.key : undefined;
  }

  async listCredentialProviders(): Promise<ReadonlySet<string>> {
    return new Set((await this.credentials.list()).map(({ providerId }) => providerId));
  }

  /** Providers with a saved API key; a subscription sign-in does not count. */
  async listApiKeyProviders(): Promise<ReadonlySet<string>> {
    return new Set(
      (await this.credentials.list()).filter(({ type }) => type === "api_key").map(({ providerId }) => providerId),
    );
  }

  isSecureStorageAvailable(): boolean {
    return this.credentials.isSecureStorageAvailable();
  }

  private async storeApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!this.credentials.isSecureStorageAvailable()) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Secure credential storage is unavailable on this device.",
      );
    }
    // A key settles the provider's credential, so an earlier failed sign-in no longer matters.
    if (this.signIn?.status === "failed" && this.signIn.providerId === providerId) this.signIn = undefined;
    await this.runtime.setRuntimeApiKey(providerId, apiKey);
    try {
      await this.credentials.setApiKey(providerId, apiKey);
    } catch (error) {
      await this.runtime.removeRuntimeApiKey(providerId).catch(() => undefined);
      throw error;
    }
  }

  async removeCredential(providerId: string): Promise<AiSettingsView> {
    const provider = this.runtime.getProvider(providerId);
    if (!provider?.auth.apiKey) {
      throw new WispBackendError("invalid_request", "The provider is invalid.");
    }

    const credential = await this.credentials.read(providerId);
    await this.runtime.removeRuntimeApiKey(providerId);
    // Signing out goes through the runtime, so it stops using the cached sign-in at once.
    if (credential?.type === "oauth") await this.runtime.logout(providerId);
    else await this.credentials.delete(providerId);
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
   * Signing in replaces a saved API key for the provider.
   */
  async startSignIn(providerId: string): Promise<AiSettingsView> {
    if (!this.offersSubscriptionSignIn(providerId)) {
      throw new WispBackendError("invalid_request", "This provider does not offer a subscription sign-in.");
    }
    if (this.signIn?.status === "waiting") {
      throw new WispBackendError("invalid_request", "A provider sign-in is already in progress.");
    }
    if (!this.credentials.isSecureStorageAvailable()) {
      throw new WispBackendError(
        "secure_storage_unavailable",
        "Secure credential storage is unavailable on this device.",
      );
    }
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

  getModelRuntime(): ModelRuntimeLike {
    return this.runtime;
  }

  async getSelection(): Promise<ModelSelection | null> {
    const selection = await this.settings.getSelection();
    if (!selection || !this.isValidSelection(selection)) return null;
    if (selection.providerId === CLAUDE_CODE_PROVIDER) {
      return (await this.claudeCodeStatus())?.state === "ready" ? selection : null;
    }
    const credential = await this.credentials.read(selection.providerId);
    return this.isUsableCredential(selection.providerId, credential) ? selection : null;
  }

  async validateConversationSelection(selection: ModelSelection): Promise<void> {
    this.assertValidSelection(selection);
    if (selection.providerId === CLAUDE_CODE_PROVIDER) {
      await this.assertClaudeCodeReady("configuration_required");
      return;
    }
    const credential = await this.credentials.read(selection.providerId);
    if (!this.isUsableCredential(selection.providerId, credential)) {
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

  private auxiliaryView(
    selection: ModelSelection | null,
    credentialProviders: ReadonlySet<string>,
  ): AuxiliaryModelView {
    return {
      selection,
      unavailable: selection ? this.auxiliaryUnavailableReason(selection, credentialProviders) : null,
    };
  }

  private fallbackView(selection: ModelSelection | null, credentialProviders: ReadonlySet<string>): FallbackModelView {
    return {
      selection,
      unavailable: selection ? this.fallbackUnavailableReason(selection, credentialProviders) : null,
    };
  }

  private fallbackUnavailableReason(
    selection: ModelSelection,
    credentialProviders: ReadonlySet<string>,
  ): FallbackModelUnavailableReason | null {
    if (!this.catalogModel(selection)) return "model_unavailable";
    return credentialProviders.has(selection.providerId) ? null : "missing_key";
  }

  /** The catalog model a selection names, from a provider that takes API keys. */
  private catalogModel(selection: ModelSelection): CatalogModel | undefined {
    return this.runtime.getProvider(selection.providerId)?.auth.apiKey
      ? this.runtime.getModel(selection.providerId, selection.modelId)
      : undefined;
  }

  private auxiliaryUnavailableReason(
    selection: ModelSelection,
    credentialProviders: ReadonlySet<string>,
  ): AuxiliaryModelUnavailableReason | null {
    const model = this.catalogModel(selection);
    if (!model) return "model_unavailable";
    if (!model.input.includes("image")) return "no_image_input";
    return credentialProviders.has(selection.providerId) ? null : "missing_key";
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

  private async assertClaudeCodeReady(code: "invalid_configuration" | "configuration_required"): Promise<void> {
    const status = await this.claudeCodeStatus();
    const unavailable =
      status?.state === "checking" ? claudeCodeUnavailableMessage(undefined) : claudeCodeUnavailableMessage(status);
    if (!status || unavailable) {
      throw new WispBackendError(code, unavailable ?? "Claude Code is not available on this server.");
    }
  }

  private isValidSelection(selection: ModelSelection): boolean {
    if (selection.providerId === CLAUDE_CODE_PROVIDER) {
      // Claude Code manages its own output limit, so a saved one is not checked.
      return Boolean(this.claudeCode && claudeCodeModel(selection.modelId));
    }
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

  /**
   * Checks a newly chosen thinking level. The default, "off", is always
   * accepted, and a saved level the catalog later drops is not rejected: Pi
   * clamps either to the nearest level the model supports.
   */
  assertSupportedThinkingLevel(selection: ModelSelection): void {
    const level = selection.thinkingLevel;
    if (!level || level === "off") return;
    const model =
      selection.providerId === CLAUDE_CODE_PROVIDER
        ? claudeCodeModel(selection.modelId)
        : this.runtime.getModel(selection.providerId, selection.modelId);
    if (model && !supportedThinkingLevels(model).includes(level)) {
      throw new WispBackendError("invalid_configuration", "The selected model does not support this reasoning level.");
    }
  }
}
