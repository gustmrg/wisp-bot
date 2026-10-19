import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiSettingsView, ProviderSignInView, ProviderSummary, ThinkingLevel } from "../../shared/contracts";
import { AuxiliaryModelSettings } from "@/components/auxiliary-model-settings";
import { FallbackModelSettings } from "@/components/fallback-model-settings";
import { ManualSignInForm } from "@/components/manual-sign-in";
import { NoImageInputNote } from "@/components/no-image-input-note";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { canChooseThinkingLevel, keepThinkingLevel, ThinkingLevelRow } from "@/components/thinking-level-select";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notifyProviderCredentialsChanged } from "@/lib/voice-credentials";
import { voiceProvider } from "../../shared/voice";

const SIGN_IN_POLL_MS = 1_500;

interface ModelSettingsSectionProps {
  active: boolean;
  /** Called with every loaded or saved view, so a parent can follow what is configured. */
  onViewChange?: (view: AiSettingsView) => void;
  /** Hide the panel title when a surrounding screen already provides one. */
  showHeading?: boolean;
  /** Show the fallback and auxiliary model pickers; first-run setup hides them. */
  showAuxiliaryModels?: boolean;
}

function initialProvider(view: AiSettingsView): ProviderSummary | undefined {
  return (
    view.providers.find(({ id }) => id === view.selection?.providerId) ??
    view.providers.find(({ id }) => id === "openrouter") ??
    view.providers[0]
  );
}

function ModelSettingsSection({
  active,
  onViewChange,
  showHeading = true,
  showAuxiliaryModels = true,
}: ModelSettingsSectionProps) {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  const provider = useMemo(() => view?.providers.find(({ id }) => id === providerId), [providerId, view]);

  const applyView = useCallback((nextView: AiSettingsView): void => {
    setView(nextView);
    onViewChangeRef.current?.(nextView);
    const nextProvider = initialProvider(nextView);
    const nextSelection = nextView.selection;
    setProviderId(nextProvider?.id ?? "");
    const nextModelId =
      nextSelection && nextSelection.providerId === nextProvider?.id
        ? nextSelection.modelId
        : (nextProvider?.models[0]?.id ?? "");
    setModelId(nextModelId);
    const savedModel =
      nextSelection && nextSelection.providerId === nextProvider?.id && nextSelection.modelId === nextModelId;
    setMaxOutputTokens(savedModel ? String(nextSelection.maxOutputTokens ?? "") : "");
    setThinkingLevel(savedModel ? (nextSelection.thinkingLevel ?? "off") : "off");
    setApiKey("");
  }, []);

  /**
   * Takes a view saved by the auxiliary picker or a provider sign-in without
   * resetting unsaved edits to the main model.
   */
  const applyAuxiliaryView = useCallback((nextView: AiSettingsView): void => {
    setView(nextView);
    onViewChangeRef.current?.(nextView);
  }, []);

  // A sign-in completes in the browser, so the view is reloaded until it ends.
  const signInWaiting = view?.providerSignIn?.status === "waiting";
  useEffect(() => {
    if (!active || !signInWaiting) return;
    const timer = setInterval(() => {
      void window.wisp
        .getAiSettings()
        .then((result) => {
          if (!result.ok) return;
          applyAuxiliaryView(result.value);
          if (result.value.providerSignIn?.status !== "waiting") notifyProviderCredentialsChanged();
        })
        .catch(() => undefined);
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [active, signInWaiting, applyAuxiliaryView]);

  useEffect(() => {
    if (!active || view) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.wisp
      .getAiSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) applyView(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load AI model settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, view, applyView]);

  function handleProviderChange(nextProviderId: string | null): void {
    if (!nextProviderId || !view) return;
    const nextProvider = view.providers.find(({ id }) => id === nextProviderId);
    const saved = view.selection?.providerId === nextProviderId ? view.selection : null;
    setProviderId(nextProviderId);
    setModelId(saved ? saved.modelId : (nextProvider?.models[0]?.id ?? ""));
    setMaxOutputTokens(saved ? String(saved.maxOutputTokens ?? "") : "");
    setThinkingLevel(saved?.thinkingLevel ?? "off");
    setApiKey("");
    setError(null);
    setSaved(false);
  }

  async function handleSave(): Promise<void> {
    if (!providerId || !modelId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.saveAiSettings({
        selection: {
          providerId,
          modelId,
          ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
          ...(effectiveThinkingLevel === "off" ? {} : { thinkingLevel: effectiveThinkingLevel }),
        },
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      applyView(result.value);
      setSaved(true);
      if (apiKey.trim()) notifyProviderCredentialsChanged();
    } catch {
      setError("Could not save AI model settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveCredential(): Promise<void> {
    if (!provider?.credentialConfigured) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.removeProviderCredential({ providerId: provider.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      applyView(result.value);
      notifyProviderCredentialsChanged();
    } catch {
      setError("Could not remove the provider API key.");
    } finally {
      setSaving(false);
    }
  }

  async function handleStartSignIn(): Promise<void> {
    if (!provider?.subscriptionSignIn) return;
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.startProviderSignIn({ providerId: provider.id });
      if (result.ok) applyAuxiliaryView(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not start the sign-in.");
    }
  }

  async function handleCancelSignIn(): Promise<void> {
    if (!provider) return;
    try {
      const result = await window.wisp.cancelProviderSignIn({ providerId: provider.id });
      if (result.ok) applyAuxiliaryView(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not cancel the sign-in.");
    }
  }

  async function handleFinishSignIn(redirectUrl: string): Promise<string | undefined> {
    if (!provider) return undefined;
    const result = await window.wisp.finishProviderSignIn({ providerId: provider.id, redirectUrl });
    if (!result.ok) return result.error.message;
    applyAuxiliaryView(result.value);
    notifyProviderCredentialsChanged();
    return undefined;
  }

  const providerItems = view?.providers.map(({ id, name }) => ({ value: id, label: name })) ?? [];
  const modelItems = provider?.models.map(({ id, name }) => ({ value: id, label: name, description: id })) ?? [];
  const model = provider?.models.find(({ id }) => id === modelId);
  const effectiveThinkingLevel = keepThinkingLevel(thinkingLevel, model);
  const parsedMaxOutputTokens = maxOutputTokens ? Number(maxOutputTokens) : undefined;
  const invalidMaxOutputTokens =
    parsedMaxOutputTokens !== undefined &&
    (!Number.isSafeInteger(parsedMaxOutputTokens) ||
      parsedMaxOutputTokens < 1 ||
      parsedMaxOutputTokens > (model?.maxOutputTokens ?? 1_000_000));
  const requiresKey = Boolean(provider && !provider.credentialConfigured && !apiKey.trim());
  const saveDisabled =
    saving ||
    !providerId ||
    !modelId ||
    requiresKey ||
    invalidMaxOutputTokens ||
    (!view?.secureStorageAvailable && !provider?.credentialConfigured);

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="model-settings-panel"
      aria-labelledby="model-settings-title"
      hidden={!active}
    >
      <h2 id="model-settings-title" className={showHeading ? "mb-1 mt-0 text-lg" : "sr-only"}>
        AI Model
      </h2>
      {showHeading ? (
        <p className="mb-[22px] text-dim text-xs leading-relaxed">
          Default provider and model for Wisps without their own selection. Saved provider keys are shared with all
          Wisps.
        </p>
      ) : null}

      {view?.catalogError ? (
        <p role="alert" className="mb-[18px] text-xs leading-relaxed text-destructive">
          Could not refresh the model catalog, so some providers or models may be missing. {view.catalogError}
        </p>
      ) : null}

      {loading ? <p className="text-dim text-sm">Loading providers and models…</p> : null}
      {!loading && view ? (
        <div className="animate-tab-forward">
          <SettingsGroup label="Provider">
            <SettingsCard variant="stacked">
              <SettingsRow>
                <SettingsRowCopy>
                  <SettingsRowTitle htmlFor="ai-provider">Provider</SettingsRowTitle>
                  <SettingsRowDescription>
                    Runs every Wisp that follows the global model. Wisps with their own model keep it.
                  </SettingsRowDescription>
                </SettingsRowCopy>
                <Select items={providerItems} value={providerId} onValueChange={handleProviderChange}>
                  <SelectTrigger id="ai-provider" className="w-[220px] max-w-[55%]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" alignItemWithTrigger={false}>
                    <SelectGroup>
                      {view.providers.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingsRow>
              <SettingsRow>
                <SettingsRowCopy>
                  <SettingsRowTitle htmlFor="ai-model">Model</SettingsRowTitle>
                  <SettingsRowDescription>
                    {provider?.models.length ?? 0} models available. Search by name or ID.
                  </SettingsRowDescription>
                  {model && !model.input.includes("image") ? <NoImageInputNote /> : null}
                </SettingsRowCopy>
                <SearchableCombobox
                  id="ai-model"
                  value={modelId}
                  options={modelItems}
                  className="h-8 w-[260px] max-w-[62%] text-base"
                  searchLabel="Search models"
                  searchPlaceholder="Search model name or ID…"
                  emptyText="No models found."
                  onChange={(value) => {
                    setModelId(value);
                    setMaxOutputTokens("");
                    setThinkingLevel((level) =>
                      keepThinkingLevel(
                        level,
                        provider?.models.find(({ id }) => id === value),
                      ),
                    );
                    setError(null);
                    setSaved(false);
                  }}
                />
              </SettingsRow>
              <SettingsRow>
                <SettingsRowCopy>
                  <SettingsRowTitle htmlFor="ai-max-output-tokens">Maximum output tokens</SettingsRowTitle>
                  <SettingsRowDescription>
                    Leave empty to use the safe automatic limit of up to 32,768 tokens.
                  </SettingsRowDescription>
                </SettingsRowCopy>
                <Input
                  id="ai-max-output-tokens"
                  type="number"
                  min={1}
                  max={model?.maxOutputTokens ?? 1_000_000}
                  step={1}
                  value={maxOutputTokens}
                  placeholder="Automatic"
                  className="w-[160px] max-w-[45%]"
                  onChange={(event) => {
                    setMaxOutputTokens(event.currentTarget.value);
                    setError(null);
                    setSaved(false);
                  }}
                />
              </SettingsRow>
              {canChooseThinkingLevel(model) ? (
                <ThinkingLevelRow
                  id="ai-thinking-level"
                  model={model}
                  value={effectiveThinkingLevel}
                  onChange={(level) => {
                    setThinkingLevel(level);
                    setError(null);
                    setSaved(false);
                  }}
                />
              ) : null}
            </SettingsCard>
          </SettingsGroup>

          <SettingsGroup label="Credential">
            <SettingsCard>
              {provider?.subscriptionSignIn ? (
                <SubscriptionSignIn
                  provider={provider}
                  label={provider.subscriptionSignIn.label}
                  signIn={view.providerSignIn?.providerId === provider.id ? view.providerSignIn : null}
                  disabled={saving || !view.secureStorageAvailable}
                  onStart={() => void handleStartSignIn()}
                  onCancel={() => void handleCancelSignIn()}
                  onFinish={handleFinishSignIn}
                  onSignOut={() => void handleRemoveCredential()}
                />
              ) : null}
              <div className="flex flex-col gap-3 px-3.5 py-3.5">
                <div className="flex flex-wrap items-start gap-3">
                  <SettingsRowCopy>
                    <SettingsRowTitle htmlFor="ai-api-key">API key</SettingsRowTitle>
                    <SettingsRowDescription>
                      {provider?.credentialKind === "subscription"
                        ? "Enter an API key to pay per token instead of using your subscription. It replaces the sign-in."
                        : provider?.credentialConfigured
                          ? `An encrypted key is saved for ${provider.name}${voiceProvider(provider.id) ? " and shared with Voice Input settings" : ""}. Enter a new key to replace it.`
                          : "The key is encrypted using your operating system's credential storage."}
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  {/* A server from before sign-ins reports no credential kind; its credentials are keys. */}
                  {provider?.credentialConfigured && provider.credentialKind !== "subscription" ? (
                    <ConfirmAction
                      label="Remove key"
                      confirmLabel="Remove key"
                      variant="ghost"
                      className="shrink-0"
                      disabled={saving}
                      description={`${voiceProvider(provider.id) ? "Voice input and Wisps" : "Wisps"} using ${provider.name} stop working until you enter a new key.`}
                      onConfirm={() => void handleRemoveCredential()}
                    />
                  ) : null}
                </div>
                <SecretInput
                  id="ai-api-key"
                  autoComplete="new-password"
                  value={apiKey}
                  disabled={!view.secureStorageAvailable}
                  placeholder={
                    provider?.credentialConfigured && provider.credentialKind !== "subscription"
                      ? "Saved — enter a replacement"
                      : "Enter API key"
                  }
                  onChange={(event) => {
                    setApiKey(event.currentTarget.value);
                    setError(null);
                    setSaved(false);
                  }}
                />
                {!view.secureStorageAvailable ? (
                  <p className="m-0 text-xs leading-relaxed text-destructive">
                    Secure credential storage is unavailable. Wisp will not save an API key as plaintext.
                  </p>
                ) : null}
              </div>
            </SettingsCard>
          </SettingsGroup>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div aria-live="polite">
              {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
              {saved ? <p className="m-0 text-xs text-dim">AI model settings saved.</p> : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" disabled={saveDisabled} onClick={() => void handleSave()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          {showAuxiliaryModels ? (
            <div className="mt-6 border-t border-border pt-2">
              {/* A server from before fallbacks reports none; it cannot save one either. */}
              {view.fallback ? <FallbackModelSettings view={view} onViewChange={applyAuxiliaryView} /> : null}
              <AuxiliaryModelSettings view={view} onViewChange={applyAuxiliaryView} />
            </div>
          ) : null}
        </div>
      ) : null}
      {!loading && !view && error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

/**
 * Signs a provider in with the person's subscription instead of an API key.
 * Requests then count against the plan's usage limits rather than being billed
 * per token.
 */
function SubscriptionSignIn({
  provider,
  label,
  signIn,
  disabled,
  onStart,
  onCancel,
  onFinish,
  onSignOut,
}: {
  provider: ProviderSummary;
  label: string;
  signIn: ProviderSignInView | null;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
  onFinish: (redirectUrl: string) => Promise<string | undefined>;
  onSignOut: () => void;
}) {
  const signedIn = provider.credentialKind === "subscription";
  const waiting = signIn?.status === "waiting";
  return (
    <div className="flex flex-col gap-3 border-b border-border px-3.5 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <SettingsRowCopy>
          <SettingsRowTitle>Subscription</SettingsRowTitle>
          <SettingsRowDescription>
            {signedIn
              ? `Signed in. Wisps using ${provider.name} count against your subscription's usage limits instead of being billed per token.`
              : waiting
                ? "Finish signing in in your browser."
                : `Use your ${provider.name} subscription instead of an API key. Requests count against your plan's usage limits instead of being billed per token.${provider.credentialKind === "api_key" ? " Signing in replaces the saved API key." : ""}`}
          </SettingsRowDescription>
        </SettingsRowCopy>
        {signedIn && !waiting ? (
          <ConfirmAction
            label="Sign out"
            confirmLabel="Sign out"
            variant="ghost"
            className="shrink-0"
            disabled={disabled}
            description={`Wisps using ${provider.name} stop working until you sign in again or enter an API key.`}
            onConfirm={onSignOut}
          />
        ) : null}
        {waiting ? (
          <Button type="button" variant="ghost" className="shrink-0" onClick={onCancel}>
            Cancel
          </Button>
        ) : signedIn ? null : (
          <Button type="button" variant="secondary" className="shrink-0" disabled={disabled} onClick={onStart}>
            {label}
          </Button>
        )}
      </div>
      {waiting && signIn.signInUrl ? <ManualSignInForm signInUrl={signIn.signInUrl} onFinish={onFinish} /> : null}
      {signIn?.status === "failed" ? (
        <p role="alert" className="m-0 text-xs leading-relaxed text-destructive">
          {signIn.error ?? "The sign-in did not complete."}
        </p>
      ) : null}
    </div>
  );
}

export { ModelSettingsSection };
