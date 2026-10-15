import { useState } from "react";

import type { AiSettingsView, AuxiliaryModelView } from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { modelOptions, modelOptionValue, parseModelOptionValue, unavailableModelOption } from "@/lib/model-choice";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";

const OFF = "off";

interface AuxiliaryModelSettingsProps {
  view: AiSettingsView;
  onViewChange: (view: AiSettingsView) => void;
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
  const [saved, setSaved] = useState(false);
  const slot = view.auxiliary.imageUnderstanding;
  const selected = slot.selection;
  const providerName = (providerId: string) => view.providers.find(({ id }) => id === providerId)?.name ?? providerId;

  const options = [
    { value: OFF, label: "Off", description: "Wisps on text-only models cannot read images" },
    ...modelOptions(view, ({ input }) => input.includes("image")),
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
      const result = await window.wisp.saveAuxiliaryModel({
        task: "imageUnderstanding",
        selection: value === OFF ? null : parseModelOptionValue(value),
      });
      if (result.ok) {
        onViewChange(result.value);
        setSaved(true);
      } else setError(result.error.message);
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
            <SettingsRowTitle htmlFor="ai-auxiliary-image-model">Image understanding</SettingsRowTitle>
            <SettingsRowDescription>
              Reads images and scanned PDF pages for Wisps whose model cannot see them, and returns the text to the
              Wisp. Those files are sent to the chosen provider. Only models that accept images, from providers with a
              saved key, are listed. Changes save automatically.
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
            id="ai-auxiliary-image-model"
            value={selected ? modelOptionValue(selected) : OFF}
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
      <div aria-live="polite" className="mt-3">
        {saved ? <p className="m-0 text-xs text-dim">Image model saved.</p> : null}
      </div>
    </SettingsGroup>
  );
}

export { AuxiliaryModelSettings };
