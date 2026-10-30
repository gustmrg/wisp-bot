import { useState, type ReactNode } from "react";

import type {
  AiSettingsView,
  AuxiliaryModelView,
  AuxiliaryTask,
  DecisionProviderSummary,
} from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/ui/secret-input";
import { modelOptions, modelOptionValue, parseModelOptionValue, unavailableModelOption } from "@/lib/model-choice";
import { modelLabLogo } from "@/lib/model-lab";
import {
  ConfirmAction,
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
 * The key of a provider that offers only decision models. It has no text model
 * to choose, so the provider form above, which saves a key with a model, does
 * not list it.
 */
function DecisionProviderKeyRow({
  provider,
  secureStorageAvailable,
  onViewChange,
  onSaved,
}: {
  provider: DecisionProviderSummary;
  secureStorageAvailable: boolean;
  onViewChange: (view: AiSettingsView) => void;
  onSaved: (message: string | null) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `ai-decision-key-${provider.id}`;

  async function run(request: () => ReturnType<typeof window.wisp.saveProviderKey>, saved: string | null) {
    setSaving(true);
    setError(null);
    onSaved(null);
    try {
      const result = await request();
      if (result.ok) {
        setApiKey("");
        onViewChange(result.value);
        onSaved(saved);
      } else setError(result.error.message);
    } catch {
      setError(`Could not change the ${provider.name} API key.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-3.5 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <SettingsRowCopy>
          <SettingsRowTitle htmlFor={id}>{provider.name} API key</SettingsRowTitle>
          <SettingsRowDescription>
            {provider.credentialConfigured
              ? `An encrypted key is saved for ${provider.name}. Enter a new key to replace it.`
              : `${provider.name} offers only decision models. The key is encrypted using your operating system's credential storage.`}
          </SettingsRowDescription>
        </SettingsRowCopy>
        {provider.credentialConfigured ? (
          <ConfirmAction
            label="Remove key"
            confirmLabel="Remove key"
            variant="ghost"
            className="shrink-0"
            disabled={saving}
            description={`Circles using a ${provider.name} model answer with their lead until you enter a new key.`}
            onConfirm={() => void run(() => window.wisp.removeProviderCredential({ providerId: provider.id }), null)}
          />
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <SecretInput
          id={id}
          autoComplete="new-password"
          value={apiKey}
          disabled={!secureStorageAvailable || saving}
          placeholder={provider.credentialConfigured ? "Saved — enter a replacement" : "Enter API key"}
          onChange={(event) => {
            setApiKey(event.currentTarget.value);
            setError(null);
          }}
        />
        <Button
          type="button"
          variant="secondary"
          className="shrink-0"
          disabled={saving || !apiKey.trim() || !secureStorageAvailable}
          onClick={() =>
            void run(
              () => window.wisp.saveProviderKey({ providerId: provider.id, apiKey }),
              `${provider.name} API key saved.`,
            )
          }
        >
          Save key
        </Button>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-xs leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}
    </div>
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
  const textProviders = new Set(view.providers.map(({ id }) => id));

  return (
    <SettingsGroup label="Auxiliary models">
      <SettingsCard variant="stacked">
        <AuxiliaryModelRow
          task="imageUnderstanding"
          id="ai-auxiliary-image-model"
          title="Image understanding"
          description="Reads images and scanned PDF pages for Wisps whose model cannot see them, and returns the text to the Wisp. Those files are sent to the chosen provider. Only models that accept images, from providers with a saved key, are listed. Changes save automatically."
          slot={image}
          options={imageOptions}
          unavailable={image.selection ? imageUnavailableText(image, providerName(image.selection.providerId)) : null}
          searchLabel="Search image models"
          emptyText="No models that accept images."
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
            description="Decides which Wisp answers a message that mentions no one, in circles set to use it. The message, the circle's recent messages, and a description of its Wisps are sent to the chosen provider. Only decision models, from providers with a saved key, are listed. Changes save automatically."
            slot={decision}
            options={decisionOptions}
            unavailable={
              decision.selection ? decisionUnavailableText(decision, providerName(decision.selection.providerId)) : null
            }
            searchLabel="Search decision models"
            emptyText="No decision models. Save a key for a provider that offers them."
            savedMessage="Decision model saved."
            saveFailedMessage="Could not save the decision model."
            onViewChange={onViewChange}
            onSaved={setSaved}
          />
        ) : null}
        {decision
          ? decisionProviders
              .filter(({ id }) => !textProviders.has(id))
              .map((provider) => (
                <DecisionProviderKeyRow
                  key={provider.id}
                  provider={provider}
                  secureStorageAvailable={view.secureStorageAvailable}
                  onViewChange={onViewChange}
                  onSaved={setSaved}
                />
              ))
          : null}
      </SettingsCard>
      <div aria-live="polite" className="mt-3">
        {saved ? <p className="m-0 text-xs text-dim">{saved}</p> : null}
      </div>
    </SettingsGroup>
  );
}

export { AuxiliaryModelSettings };
