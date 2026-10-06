import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AiSettingsView, ProviderSummary } from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ModelSettingsSectionProps {
  active: boolean;
  /** Called with every loaded or saved view, so a parent can follow what is configured. */
  onViewChange?: (view: AiSettingsView) => void;
  /** Hide the panel title when a surrounding screen already provides one. */
  showHeading?: boolean;
}

function initialProvider(view: AiSettingsView): ProviderSummary | undefined {
  return (
    view.providers.find(({ id }) => id === view.selection?.providerId) ??
    view.providers.find(({ id }) => id === "openrouter") ??
    view.providers[0]
  );
}

function ModelSettingsSection({ active, onViewChange, showHeading = true }: ModelSettingsSectionProps) {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
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
    setMaxOutputTokens(
      nextSelection && nextSelection.providerId === nextProvider?.id && nextSelection.modelId === nextModelId
        ? String(nextSelection.maxOutputTokens ?? "")
        : "",
    );
    setApiKey("");
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
    setProviderId(nextProviderId);
    setModelId(
      view.selection?.providerId === nextProviderId ? view.selection.modelId : (nextProvider?.models[0]?.id ?? ""),
    );
    setMaxOutputTokens(
      view.selection?.providerId === nextProviderId ? String(view.selection.maxOutputTokens ?? "") : "",
    );
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
        },
        ...(apiKey.trim() ? { apiKey } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      applyView(result.value);
      setSaved(true);
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
    } catch {
      setError("Could not remove the provider API key.");
    } finally {
      setSaving(false);
    }
  }

  const providerItems = view?.providers.map(({ id, name }) => ({ value: id, label: name })) ?? [];
  const modelItems = provider?.models.map(({ id, name }) => ({ value: id, label: name, description: id })) ?? [];
  const model = provider?.models.find(({ id }) => id === modelId);
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
      <h2 id="model-settings-title" className={showHeading ? "mb-1 mt-0 text-[17px]" : "sr-only"}>
        AI Model
      </h2>
      {showHeading ? (
        <p className="mb-[22px] text-dim text-[11.5px] leading-relaxed">
          Default provider and model for Wisps without their own selection. Saved provider keys are shared with all
          Wisps.
        </p>
      ) : null}

      {view?.catalogError ? (
        <p role="alert" className="mb-[18px] text-[11.5px] leading-relaxed text-destructive">
          Could not refresh the model catalog, so some providers or models may be missing. {view.catalogError}
        </p>
      ) : null}

      {loading ? <p className="text-dim text-[12px]">Loading providers and models…</p> : null}
      {!loading && view ? (
        <div className="animate-tab-forward">
          <SettingsGroup label="Provider">
            <SettingsCard variant="stacked">
              <SettingsRow>
                <SettingsRowCopy>
                  <label htmlFor="ai-provider">
                    <strong>Provider</strong>
                  </label>
                  <small>Select the service that will run your Wisps.</small>
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
                  <label htmlFor="ai-model">
                    <strong>Model</strong>
                  </label>
                  <small>{provider?.models.length ?? 0} models available. Search by name or ID.</small>
                </SettingsRowCopy>
                <SearchableCombobox
                  id="ai-model"
                  value={modelId}
                  options={modelItems}
                  className="h-8 w-[260px] max-w-[62%] text-sm"
                  searchLabel="Search models"
                  searchPlaceholder="Search model name or ID…"
                  emptyText="No models found."
                  onChange={(value) => {
                    setModelId(value);
                    setMaxOutputTokens("");
                    setError(null);
                    setSaved(false);
                  }}
                />
              </SettingsRow>
              <SettingsRow>
                <SettingsRowCopy>
                  <label htmlFor="ai-max-output-tokens">
                    <strong>Maximum output tokens</strong>
                  </label>
                  <small>Leave empty to use the safe automatic limit of up to 32,768 tokens.</small>
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
            </SettingsCard>
          </SettingsGroup>

          <SettingsGroup label="Credential">
            <SettingsCard>
              <div className="flex flex-col gap-3 px-3.5 py-3.5">
                <SettingsRowCopy>
                  <label htmlFor="ai-api-key">
                    <strong>API key</strong>
                  </label>
                  <small>
                    {provider?.credentialConfigured
                      ? `An encrypted key is saved for ${provider.name}. Enter a new key to replace it.`
                      : "The key is encrypted using your operating system's credential storage."}
                  </small>
                </SettingsRowCopy>
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
                  <p className="m-0 text-[11.5px] leading-relaxed text-destructive">
                    Secure credential storage is unavailable. Wisp will not save an API key as plaintext.
                  </p>
                ) : null}
              </div>
            </SettingsCard>
          </SettingsGroup>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div aria-live="polite">
              {error ? <p className="m-0 text-[11.5px] text-destructive">{error}</p> : null}
              {saved ? <p className="m-0 text-[11.5px] text-dim">AI model settings saved.</p> : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {provider?.credentialConfigured ? (
                <ConfirmAction
                  label="Remove key"
                  confirmLabel="Remove key"
                  disabled={saving}
                  description={`Wisps using ${provider.name} stop working until you enter a new key.`}
                  onConfirm={() => void handleRemoveCredential()}
                />
              ) : null}
              <Button type="button" disabled={saveDisabled} onClick={() => void handleSave()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {!loading && !view && error ? <p className="text-[12px] text-destructive">{error}</p> : null}
    </section>
  );
}

export { ModelSettingsSection };
