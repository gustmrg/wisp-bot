import { useEffect, useState } from "react";

import type { AiSettingsView, ModelSelection, ThinkingLevel } from "../../shared/contracts";
import { AdvancedSettings } from "@/components/advanced-settings";
import { AuxiliaryModelSettings } from "@/components/auxiliary-model-settings";
import { FallbackModelSettings } from "@/components/fallback-model-settings";
import { NoImageInputNote } from "@/components/no-image-input-note";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { canChooseThinkingLevel, keepThinkingLevel, ThinkingLevelRow } from "@/components/thinking-level-select";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  catalogModel,
  invalidMaxOutputTokens,
  modelOptions,
  modelOptionValue,
  parseModelOptionValue,
  unavailableModelOption,
} from "@/lib/model-choice";
import { CLAUDE_CODE_PROVIDER } from "../../shared/claude-code";

interface ModelSettingsSectionProps {
  onOpenProviders: () => void;
}

/** Chooses which model does what. The providers those models come from are connected under Providers. */
function ModelSettingsSection({ onOpenProviders }: ModelSettingsSectionProps) {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.wisp
      .getAiSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setView(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load AI model settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="model-settings-panel"
      aria-labelledby="model-settings-title"
    >
      <SettingsPanelTitle id="model-settings-title" scope="environment">
        AI Model
      </SettingsPanelTitle>
      <p className="mb-[22px] text-dim text-xs leading-relaxed">
        The default model for Wisps without their own. Models come from your connected{" "}
        <Button variant="link" size="xs" type="button" className="h-auto p-0" onClick={onOpenProviders}>
          providers
        </Button>
        .
      </p>

      {view?.catalogError ? (
        <p role="alert" className="mb-[18px] text-xs leading-relaxed text-destructive">
          Could not refresh the model catalog, so some providers or models may be missing. {view.catalogError}
        </p>
      ) : null}

      {!view && !error ? <p className="text-dim text-sm">Loading models…</p> : null}
      {view ? (
        <div className="animate-panel-in">
          <DefaultModelSettings view={view} onViewChange={setView} />
          <FallbackModelSettings view={view} onViewChange={setView} />
          <AuxiliaryModelSettings view={view} onViewChange={setView} />
        </div>
      ) : null}
      {!view && error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

/** Chooses the model Wisps follow unless they have their own. Saves on change, like the pickers below it. */
function DefaultModelSettings({
  view,
  onViewChange,
}: {
  view: AiSettingsView;
  onViewChange: (view: AiSettingsView) => void;
}) {
  const selection = view.selection;
  const savedMaxOutputTokens = String(selection?.maxOutputTokens ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(savedMaxOutputTokens);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setMaxOutputTokens(savedMaxOutputTokens), [savedMaxOutputTokens]);

  const options = modelOptions(view);
  if (selection && !options.some(({ value }) => value === modelOptionValue(selection))) {
    options.push(unavailableModelOption(view, selection));
  }
  const model = selection ? catalogModel(view, selection) : undefined;
  const thinkingLevel = keepThinkingLevel(selection?.thinkingLevel ?? "off", model);
  const maxOutputTokensInvalid = invalidMaxOutputTokens(maxOutputTokens, model?.maxOutputTokens);

  async function save(next: ModelSelection): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.saveAiSettings({ selection: next });
      if (result.ok) {
        onViewChange(result.value);
        setSaved(true);
      } else setError(result.error.message);
    } catch {
      setError("Could not save the default model.");
    } finally {
      setSaving(false);
    }
  }

  function handleModelChange(value: string): void {
    if (selection && value === modelOptionValue(selection)) return;
    const next = parseModelOptionValue(value);
    const level = keepThinkingLevel(selection?.thinkingLevel ?? "off", catalogModel(view, next));
    void save({ ...next, ...(level === "off" ? {} : { thinkingLevel: level }) });
  }

  function handleThinkingChange(level: ThinkingLevel): void {
    if (!selection) return;
    const { thinkingLevel: _previous, ...rest } = selection;
    void save({ ...rest, ...(level === "off" ? {} : { thinkingLevel: level }) });
  }

  function handleMaxOutputTokensCommit(): void {
    if (!selection || maxOutputTokensInvalid || maxOutputTokens === savedMaxOutputTokens) return;
    const { maxOutputTokens: _previous, ...rest } = selection;
    void save({ ...rest, ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}) });
  }

  return (
    <SettingsGroup label="Default">
      <SettingsCard variant="stacked">
        <SettingsRow>
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="ai-model">Default model</SettingsRowTitle>
            {selection ? null : (
              <SettingsRowDescription>Wisps can't respond until you choose one.</SettingsRowDescription>
            )}
            {model && !model.input.includes("image") ? <NoImageInputNote /> : null}
            {error ? (
              <span role="alert" className="text-xs leading-relaxed text-destructive">
                {error}
              </span>
            ) : null}
          </SettingsRowCopy>
          <SearchableCombobox
            id="ai-model"
            value={selection ? modelOptionValue(selection) : ""}
            options={options}
            disabled={saving}
            placeholder="Choose a model"
            className="h-8 w-[260px] max-w-[62%] text-base"
            searchLabel="Search models"
            searchPlaceholder="Search model name or ID…"
            emptyText="No models yet. Connect a provider first."
            onChange={handleModelChange}
          />
        </SettingsRow>
        {canChooseThinkingLevel(model) ? (
          <ThinkingLevelRow
            id="ai-thinking-level"
            model={model}
            value={thinkingLevel}
            disabled={saving}
            onChange={handleThinkingChange}
          />
        ) : null}
      </SettingsCard>
      {/* Claude Code manages its own output limit (ADR 026). */}
      {selection && selection.providerId !== CLAUDE_CODE_PROVIDER ? (
        <AdvancedSettings defaultOpen={Boolean(savedMaxOutputTokens)} className="mt-1.5">
          <SettingsCard>
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
                onChange={(event) => setMaxOutputTokens(event.currentTarget.value)}
                onBlur={handleMaxOutputTokensCommit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </SettingsRow>
          </SettingsCard>
          {maxOutputTokensInvalid ? (
            <p role="alert" className="m-0 mt-1.5 px-0.5 text-xs text-destructive">
              Maximum output tokens must be a whole number between 1 and{" "}
              {(model?.maxOutputTokens ?? 1_000_000).toLocaleString()}.
            </p>
          ) : null}
        </AdvancedSettings>
      ) : null}
      <div aria-live="polite" className="mt-2">
        {saved ? <p className="m-0 text-xs text-dim">Default model saved.</p> : null}
      </div>
    </SettingsGroup>
  );
}

export { ModelSettingsSection };
