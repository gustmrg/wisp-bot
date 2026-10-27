import { useState } from "react";
import { Trash2Icon } from "lucide-react";

import {
  MAX_FALLBACK_MODELS,
  type AiSettingsView,
  type FallbackModelView,
  type ModelSelection,
} from "../../shared/contracts";
import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { modelOptions, modelOptionValue, parseModelOptionValue, unavailableModelOption } from "@/lib/model-choice";

const OFF = "off";
const ROW_TITLES = ["Fallback model", "Second fallback", "Third fallback"];

interface FallbackModelSettingsProps {
  view: AiSettingsView;
  onViewChange: (view: AiSettingsView) => void;
}

function unavailableText(fallback: FallbackModelView, providerName: string, only: boolean): string | null {
  const consequence = only ? "Until then, Wisps have no fallback." : "Until then, it is skipped.";
  switch (fallback.unavailable) {
    case "missing_key":
      return `Add an API key for ${providerName} to use this model. ${consequence}`;
    case "model_unavailable":
      return only
        ? "This model is no longer in the catalog, so Wisps have no fallback. Choose another model."
        : "This model is no longer in the catalog, so it is skipped. Choose another model.";
    default:
      return null;
  }
}

/**
 * Chooses the models that answer when the global model fails, tried in order
 * (ADR 035). A server before the list keeps one. Saves on change.
 */
function FallbackModelSettings({ view, onViewChange }: FallbackModelSettingsProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fallbacks: ReadonlyArray<FallbackModelView> =
    view.fallbacks ?? (view.fallback.selection ? [view.fallback] : []);
  const selections = fallbacks.flatMap(({ selection }) => (selection ? [selection] : []));
  const limit = view.fallbacks ? MAX_FALLBACK_MODELS : 1;
  const primary = view.selection;
  const providerName = (providerId: string) => view.providers.find(({ id }) => id === providerId)?.name ?? providerId;

  /** Models a row can choose: not the global model, and not one another row already chose. */
  function rowOptions(index: number) {
    const taken = new Set(
      [primary, ...selections.filter((_, other) => other !== index)].flatMap((selection) =>
        selection ? [modelOptionValue(selection)] : [],
      ),
    );
    const options = modelOptions(view, undefined, { runtime: "pi" }).filter(({ value }) => !taken.has(value));
    const own = selections[index];
    if (own && !options.some(({ value }) => value === modelOptionValue(own))) {
      options.push(unavailableModelOption(view, own));
    }
    return options;
  }

  async function save(next: ReadonlyArray<ModelSelection>): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.saveFallbackModel(
        view.fallbacks ? { selection: next[0] ?? null, selections: next } : { selection: next[0] ?? null },
      );
      if (result.ok) {
        onViewChange(result.value);
        setSaved(true);
      } else setError(result.error.message);
    } catch {
      setError("Could not save the fallback models.");
    } finally {
      setSaving(false);
    }
  }

  function choose(index: number, value: string): void {
    const current = selections[index];
    if (value === (current ? modelOptionValue(current) : OFF)) return;
    // Turning the first one off turns every fallback off.
    if (value === OFF) return void save([]);
    const next = [...selections];
    next[index] = parseModelOptionValue(value);
    void save(next);
  }

  const first = selections[0];
  const rows = fallbacks.slice(1, limit);
  const canAdd = first !== undefined && selections.length < limit;
  return (
    <SettingsGroup label="Fallback">
      <SettingsCard>
        <SettingsRow>
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="ai-fallback-model">{ROW_TITLES[0]}</SettingsRowTitle>
            <SettingsRowDescription>
              Answers for Wisps on the global model when it fails before answering: at once when the provider is out of
              credits or rejects the key, and after the retries when it is rate limited or down. Each message tries the
              global model first, unless it is on hold after a rate limit. Wisps with a model of their own choose their
              fallback in their settings. Only models from providers with a saved key are listed. Changes save
              automatically.
            </SettingsRowDescription>
            <RowWarning
              text={
                fallbacks[0] && first
                  ? unavailableText(fallbacks[0], providerName(first.providerId), selections.length === 1)
                  : null
              }
            />
            {error ? (
              <span role="alert" className="text-xs leading-relaxed text-destructive">
                {error}
              </span>
            ) : null}
          </SettingsRowCopy>
          <SearchableCombobox
            id="ai-fallback-model"
            value={first ? modelOptionValue(first) : OFF}
            options={[
              { value: OFF, label: "Off", description: "Wisps stop when the global model fails" },
              ...rowOptions(0),
            ]}
            disabled={saving}
            className="h-8 w-[260px] max-w-[62%] text-base"
            searchLabel="Search fallback models"
            searchPlaceholder="Search model name or ID…"
            emptyText="No models from providers with a saved key."
            onChange={(value) => choose(0, value)}
          />
        </SettingsRow>
        {rows.map((fallback, offset) => {
          const index = offset + 1;
          const selection = selections[index]!;
          const title = ROW_TITLES[index]!;
          return (
            <SettingsRow key={modelOptionValue(selection)}>
              <SettingsRowCopy>
                <SettingsRowTitle htmlFor={`ai-fallback-model-${index}`}>{title}</SettingsRowTitle>
                <SettingsRowDescription>Answers when the one before it fails too.</SettingsRowDescription>
                <RowWarning text={unavailableText(fallback, providerName(selection.providerId), false)} />
              </SettingsRowCopy>
              <div className="flex max-w-[62%] items-center gap-1">
                <SearchableCombobox
                  id={`ai-fallback-model-${index}`}
                  value={modelOptionValue(selection)}
                  options={rowOptions(index)}
                  disabled={saving}
                  className="h-8 w-[220px] max-w-full text-base"
                  searchLabel="Search fallback models"
                  searchPlaceholder="Search model name or ID…"
                  emptyText="No other models from providers with a saved key."
                  onChange={(value) => choose(index, value)}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove the ${title.toLowerCase()}`}
                  disabled={saving}
                  onClick={() => void save(selections.filter((_, other) => other !== index))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            </SettingsRow>
          );
        })}
        {canAdd ? (
          <SettingsRow>
            <SettingsRowCopy>
              <SettingsRowTitle htmlFor="ai-fallback-model-next">Another fallback</SettingsRowTitle>
              <SettingsRowDescription>
                Tried after the ones above, in order, when they fail too. Up to {MAX_FALLBACK_MODELS}.
              </SettingsRowDescription>
            </SettingsRowCopy>
            <SearchableCombobox
              id="ai-fallback-model-next"
              value=""
              placeholder="Choose a model"
              options={rowOptions(selections.length)}
              disabled={saving}
              className="h-8 w-[260px] max-w-[62%] text-base"
              searchLabel="Search fallback models"
              searchPlaceholder="Search model name or ID…"
              emptyText="No other models from providers with a saved key."
              onChange={(value) => void save([...selections, parseModelOptionValue(value)])}
            />
          </SettingsRow>
        ) : null}
      </SettingsCard>
      <div aria-live="polite" className="mt-3">
        {saved ? <p className="m-0 text-xs text-dim">Fallback models saved.</p> : null}
      </div>
    </SettingsGroup>
  );
}

function RowWarning({ text }: { text: string | null }) {
  return text ? (
    <span role="alert" className="text-xs leading-relaxed text-warning">
      {text}
    </span>
  ) : null;
}

export { FallbackModelSettings };
