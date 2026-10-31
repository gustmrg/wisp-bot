import { useState, type ReactNode } from "react";

import type { AiSettingsView, AuxiliaryModelView, AuxiliaryTask } from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { modelOptions, modelOptionValue, parseModelOptionValue, unavailableModelOption } from "@/lib/model-choice";
import { modelLabLogo } from "@/lib/model-lab";
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

function imageUnavailableText(slot: AuxiliaryModelView, providerName: string): string | null {
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

function decisionUnavailableText(slot: AuxiliaryModelView, providerName: string): string | null {
  switch (slot.unavailable) {
    case "missing_key":
      return `Add an API key for ${providerName} to use this model. Until then, circles answer with their lead.`;
    case "model_unavailable":
      return "This model is no longer in the catalog, so circles answer with their lead. Choose another model.";
    default:
      return null;
  }
}

interface ModelOption {
  value: string;
  label: string;
  description: string;
  iconSrc: string | undefined;
}

/** One auxiliary task's picker. Saves on change. */
function AuxiliaryModelRow({
  task,
  id,
  title,
  description,
  slot,
  options,
  unavailable,
  searchLabel,
  emptyText,
  savedMessage,
  saveFailedMessage,
  onViewChange,
  onSaved,
}: {
  task: AuxiliaryTask;
  id: string;
  title: string;
  description: ReactNode;
  slot: AuxiliaryModelView;
  /** Off first, then the models, then a saved model no longer offered. */
  options: ReadonlyArray<ModelOption | { value: string; label: string; description: string }>;
  unavailable: string | null;
  searchLabel: string;
  emptyText: string;
  savedMessage: string;
  saveFailedMessage: string;
  onViewChange: (view: AiSettingsView) => void;
  onSaved: (message: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = slot.selection;

  async function handleChange(value: string): Promise<void> {
    if (value === (selected ? modelOptionValue(selected) : OFF)) return;
    setSaving(true);
    setError(null);
    onSaved(null);
    try {
      const result = await window.wisp.saveAuxiliaryModel({
        task,
        selection: value === OFF ? null : parseModelOptionValue(value),
      });
      if (result.ok) {
        onViewChange(result.value);
        onSaved(savedMessage);
      } else setError(result.error.message);
    } catch {
      setError(saveFailedMessage);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow>
      <SettingsRowCopy>
        <SettingsRowTitle htmlFor={id}>{title}</SettingsRowTitle>
        <SettingsRowDescription>{description}</SettingsRowDescription>
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
        id={id}
        value={selected ? modelOptionValue(selected) : OFF}
        options={[...options]}
        disabled={saving}
        className="h-8 w-[260px] max-w-[62%] text-base"
        searchLabel={searchLabel}
        searchPlaceholder="Search model name or ID…"
        emptyText={emptyText}
        onChange={(value) => void handleChange(value)}
      />
    </SettingsRow>
  );
}

/**
 * Chooses the models for auxiliary tasks: the one that reads images for Wisps
 * whose own model cannot, and the one that decides who answers in a circle.
 */
function AuxiliaryModelSettings({ view, onViewChange }: AuxiliaryModelSettingsProps) {
  const [saved, setSaved] = useState<string | null>(null);
  const decisionProviders = view.decisionProviders ?? [];
  const providerName = (providerId: string) =>
    view.providers.find(({ id }) => id === providerId)?.name ??
    decisionProviders.find(({ id }) => id === providerId)?.name ??
    providerId;

  const image = view.auxiliary.imageUnderstanding;
  const imageOptions = [
    { value: OFF, label: "Off", description: "Wisps on text-only models cannot read images" },
    ...modelOptions(view, ({ input }) => input.includes("image"), { claudeCode: false }),
  ];
  if (image.selection && !imageOptions.some(({ value }) => value === modelOptionValue(image.selection!))) {
    imageOptions.push(unavailableModelOption(view, image.selection));
  }

  const decision = view.auxiliary.decision;
  const decisionOptions: ModelOption[] = [
    { value: OFF, label: "Off", description: "Circles answer with their lead", iconSrc: undefined },
    ...decisionProviders
      .filter(({ credentialConfigured }) => credentialConfigured)
      .flatMap((provider) =>
        provider.models.map(({ id, name }) => ({
          value: modelOptionValue({ providerId: provider.id, modelId: id }),
          label: name,
          description: `${provider.name} · ${id}`,
          iconSrc: modelLabLogo({ providerId: provider.id, modelId: id }),
        })),
      ),
  ];
  if (decision?.selection && !decisionOptions.some(({ value }) => value === modelOptionValue(decision.selection!))) {
    decisionOptions.push({
      ...unavailableModelOption(view, decision.selection),
      description: providerName(decision.selection.providerId),
    });
  }

  return (
    <SettingsGroup label="Background tasks">
      <SettingsCard variant="stacked">
        <AuxiliaryModelRow
          task="imageUnderstanding"
          id="ai-auxiliary-image-model"
          title="Reading images"
          description="Reads images and scanned PDFs for Wisps whose model can't, sending those files to the chosen provider."
          slot={image}
          options={imageOptions}
          unavailable={image.selection ? imageUnavailableText(image, providerName(image.selection.providerId)) : null}
          searchLabel="Search image models"
          emptyText="No models that accept images. Connect a provider that offers them."
          savedMessage="Image model saved."
          saveFailedMessage="Could not save the image model."
          onViewChange={onViewChange}
          onSaved={setSaved}
        />
        {decision ? (
          <AuxiliaryModelRow
            task="decision"
            id="ai-auxiliary-decision-model"
            title="Decision model"
            description="Picks who answers when a circle message mentions no one. Sends recent messages and Wisp descriptions to the chosen provider."
            slot={decision}
            options={decisionOptions}
            unavailable={
              decision.selection ? decisionUnavailableText(decision, providerName(decision.selection.providerId)) : null
            }
            searchLabel="Search decision models"
            emptyText="No decision models. Connect a provider that offers them."
            savedMessage="Decision model saved."
            saveFailedMessage="Could not save the decision model."
            onViewChange={onViewChange}
            onSaved={setSaved}
          />
        ) : null}
      </SettingsCard>
      <div aria-live="polite" className="mt-3">
        {saved ? <p className="m-0 text-xs text-dim">{saved}</p> : null}
      </div>
    </SettingsGroup>
  );
}

export { AuxiliaryModelSettings };
