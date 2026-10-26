import { useState } from "react";

import type { AiSettingsView, FallbackModelView } from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { modelOptions, modelOptionValue, parseModelOptionValue, unavailableModelOption } from "@/lib/model-choice";

const OFF = "off";

interface FallbackModelSettingsProps {
  view: AiSettingsView;
  onViewChange: (view: AiSettingsView) => void;
}

function unavailableText(fallback: FallbackModelView, providerName: string): string | null {
  switch (fallback.unavailable) {
    case "missing_key":
      return `Add an API key for ${providerName} to use this model. Until then, Wisps have no fallback.`;
    case "model_unavailable":
      return "This model is no longer in the catalog, so Wisps have no fallback. Choose another model.";
    default:
      return null;
  }
}

/** Chooses the model that answers when the global model fails for good. Saves on change. */
function FallbackModelSettings({ view, onViewChange }: FallbackModelSettingsProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selected = view.fallback.selection;
  const primary = view.selection;
  const providerName = (providerId: string) => view.providers.find(({ id }) => id === providerId)?.name ?? providerId;

  const options = [
    { value: OFF, label: "Off", description: "Wisps stop when the global model fails" },
    // The global model cannot stand in for itself.
    ...modelOptions(view, undefined, { runtime: "pi" }).filter(
      ({ value }) => !primary || value !== modelOptionValue(primary),
    ),
  ];
  if (selected && !options.some(({ value }) => value === modelOptionValue(selected))) {
    options.push(unavailableModelOption(view, selected));
  }

  async function handleChange(value: string): Promise<void> {
    if (value === (selected ? modelOptionValue(selected) : OFF)) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.saveFallbackModel({
        selection: value === OFF ? null : parseModelOptionValue(value),
      });
      if (result.ok) {
        onViewChange(result.value);
        setSaved(true);
      } else setError(result.error.message);
    } catch {
      setError("Could not save the fallback model.");
    } finally {
      setSaving(false);
    }
  }

  const unavailable = selected ? unavailableText(view.fallback, providerName(selected.providerId)) : null;
  return (
    <SettingsGroup label="Fallback">
      <SettingsCard>
        <SettingsRow>
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="ai-fallback-model">Fallback model</SettingsRowTitle>
            <SettingsRowDescription>
              Answers for Wisps on the global model when it fails for good, for example when the provider is out of
              credits or rejects the key. Each message tries the global model first. Wisps with a model of their own
              choose their fallback in their settings. Only models from providers with a saved key are listed. Changes
              save automatically.
            </SettingsRowDescription>
            {unavailable ? (
              <span role="alert" className="text-xs leading-relaxed text-warning">
                {unavailable}
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="text-xs leading-relaxed text-destructive">
                {error}
              </span>
            ) : null}
          </SettingsRowCopy>
          <SearchableCombobox
            id="ai-fallback-model"
            value={selected ? modelOptionValue(selected) : OFF}
            options={options}
            disabled={saving}
            className="h-8 w-[260px] max-w-[62%] text-base"
            searchLabel="Search fallback models"
            searchPlaceholder="Search model name or ID…"
            emptyText="No models from providers with a saved key."
            onChange={(value) => void handleChange(value)}
          />
        </SettingsRow>
      </SettingsCard>
      <div aria-live="polite" className="mt-3">
        {saved ? <p className="m-0 text-xs text-dim">Fallback model saved.</p> : null}
      </div>
    </SettingsGroup>
  );
}

export { FallbackModelSettings };
