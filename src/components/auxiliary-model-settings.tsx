import { useState } from "react";

import type { AiSettingsView, AuxiliaryModelView, ModelSelection } from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { SettingsCard, SettingsGroup, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";

const OFF = "off";

interface AuxiliaryModelSettingsProps {
  view: AiSettingsView;
  onViewChange: (view: AiSettingsView) => void;
}

/** Ids never hold control characters, so one joins provider and model into an option value. */
function optionValue({ providerId, modelId }: ModelSelection): string {
  return `${providerId}\u001f${modelId}`;
}

function parseOptionValue(value: string): ModelSelection | null {
  if (value === OFF) return null;
  const [providerId = "", modelId = ""] = value.split("\u001f");
  return { providerId, modelId };
}

function unavailableText(slot: AuxiliaryModelView, providerName: string): string | null {
  switch (slot.unavailable) {
    case "missing_key":
      return `Add an API key for ${providerName} to use this model. Until then, images are not sent to it.`;
    case "model_unavailable":
      return "This model is no longer in the catalog, so images are not sent to it. Choose another model.";
    case "no_image_input":
      return "This model no longer accepts images, so images are not sent to it. Choose another model.";
    default:
      return null;
  }
}

/** Chooses the model that reads images for Wisps whose own model cannot. Saves on change. */
function AuxiliaryModelSettings({ view, onViewChange }: AuxiliaryModelSettingsProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slot = view.auxiliary.imageUnderstanding;
  const selected = slot.selection;
  const providerName = (providerId: string) => view.providers.find(({ id }) => id === providerId)?.name ?? providerId;

  const options = [
    { value: OFF, label: "Off", description: "Wisps on text-only models cannot read images" },
    ...view.providers
      .filter(({ credentialConfigured }) => credentialConfigured)
      .flatMap((provider) =>
        provider.models
          .filter(({ input }) => input.includes("image"))
          .map((model) => ({
            value: optionValue({ providerId: provider.id, modelId: model.id }),
            label: model.name,
            description: `${provider.name} · ${model.id}`,
          })),
      ),
  ];
  if (selected && !options.some(({ value }) => value === optionValue(selected))) {
    options.push({
      value: optionValue(selected),
      label: `${selected.modelId} (unavailable)`,
      description: providerName(selected.providerId),
    });
  }

  async function handleChange(value: string): Promise<void> {
    if (value === (selected ? optionValue(selected) : OFF)) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.wisp.saveAuxiliaryModel({
        task: "imageUnderstanding",
        selection: parseOptionValue(value),
      });
      if (result.ok) onViewChange(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not save the image model.");
    } finally {
      setSaving(false);
    }
  }

  const unavailable = selected ? unavailableText(slot, providerName(selected.providerId)) : null;
  return (
    <SettingsGroup label="Auxiliary models">
      <SettingsCard>
        <SettingsRow>
          <SettingsRowCopy>
            <label htmlFor="ai-auxiliary-image-model">
              <strong>Image understanding</strong>
            </label>
            <small>
              Reads images and scanned PDF pages for Wisps whose model cannot see them, and returns the text to the
              Wisp. Those files are sent to the chosen provider. Only models that accept images, from providers with a
              saved key, are listed.
            </small>
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
            id="ai-auxiliary-image-model"
            value={selected ? optionValue(selected) : OFF}
            options={options}
            disabled={saving}
            className="h-8 w-[260px] max-w-[62%] text-base"
            searchLabel="Search image models"
            searchPlaceholder="Search model name or ID…"
            emptyText="No models that accept images."
            onChange={(value) => void handleChange(value)}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsGroup>
  );
}

export { AuxiliaryModelSettings };
