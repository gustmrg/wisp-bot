import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiSettingsView, ProviderSummary, ThinkingLevel } from "../../shared/contracts";
import { AuxiliaryModelSettings } from "@/components/auxiliary-model-settings";
import { FallbackModelSettings } from "@/components/fallback-model-settings";
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notifyProviderCredentialsChanged } from "@/lib/voice-credentials";
import { voiceProvider } from "../../shared/voice";

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

  /** Takes a view saved by the auxiliary picker without resetting unsaved edits to the main model. */
  const applyAuxiliaryView = useCallback((nextView: AiSettingsView): void => {
    setView(nextView);
    onViewChangeRef.current?.(nextView);
  }, []);

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
              <div className="flex flex-col gap-3 px-3.5 py-3.5">
                <div className="flex flex-wrap items-start gap-3">
                  <SettingsRowCopy>
                    <SettingsRowTitle htmlFor="ai-api-key">API key</SettingsRowTitle>
                    <SettingsRowDescription>
                      {provider?.credentialConfigured
                        ? `An encrypted key is saved for ${provider.name}${voiceProvider(provider.id) ? " and shared with Voice Input settings" : ""}. Enter a new key to replace it.`
                        : "The key is encrypted using your operating system's credential storage."}
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  {provider?.credentialConfigured ? (
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
                <Input
                  id="ai-api-key"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  disabled={!view.secureStorageAvailable}
                  placeholder={provider?.credentialConfigured ? "Saved — enter a replacement" : "Enter API key"}
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

export { ModelSettingsSection };
