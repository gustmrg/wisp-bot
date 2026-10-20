import { CLAUDE_CODE_PROVIDER, claudeCodeUnavailableMessage } from "../../shared/claude-code";
import type { AiSettingsView, ModelSelection, ThinkingLevel } from "../../shared/contracts";
import { missingModelSetup } from "../../shared/setup-status";
import { NoImageInputNote } from "@/components/no-image-input-note";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { canChooseThinkingLevel, keepThinkingLevel, ThinkingLevelRow } from "@/components/thinking-level-select";
import {
  SettingsCard,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import {
  catalogModel,
  invalidMaxOutputTokens,
  isModelOptionValue,
  modelName,
  modelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from "@/lib/model-choice";
import { modelLabLogo } from "@/lib/model-lab";

export interface WispModelDraft {
  useGlobal: boolean;
  providerId: string;
  modelId: string;
  /** Only a template sets it; the Wisp's Model tab changes it afterwards. */
  maxOutputTokens: string;
  thinkingLevel: ThinkingLevel;
}

export function createDefaultWispModelDraft(): WispModelDraft {
  return { useGlobal: true, providerId: "", modelId: "", maxOutputTokens: "", thinkingLevel: "off" };
}

export function resolveWispModelSelection(draft: WispModelDraft): ModelSelection | null {
  if (draft.useGlobal || !draft.providerId || !draft.modelId) return null;
  const maxOutputTokens = draft.maxOutputTokens.trim();
  return {
    providerId: draft.providerId,
    modelId: draft.modelId,
    ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
    ...(draft.thinkingLevel === "off" ? {} : { thinkingLevel: draft.thinkingLevel }),
  };
}

/**
 * Selects a template's model when this app knows it. A provider without a saved key stays selected,
 * so the person is asked to add one; a model this app does not offer falls back to the global default.
 */
export function wispModelDraftFromTemplate(
  model: ModelSelection | undefined,
  view: AiSettingsView | null,
): { draft: WispModelDraft; notice: string } {
  const fallback = createDefaultWispModelDraft();
  if (!model) return { draft: fallback, notice: "" };
  const provider = view?.providers.find(({ id }) => id === model.providerId);
  const known = provider?.models.find(({ id }) => id === model.modelId);
  if (!provider || !known) {
    return {
      draft: fallback,
      notice: `This template uses ${model.modelId} from ${provider?.name ?? model.providerId}, which isn't available here. The global model is selected instead; you can choose another.`,
    };
  }
  const maxOutputTokens =
    model.maxOutputTokens !== undefined && model.maxOutputTokens <= (known.maxOutputTokens ?? 1_000_000)
      ? String(model.maxOutputTokens)
      : "";
  return {
    draft: {
      useGlobal: false,
      providerId: provider.id,
      modelId: known.id,
      maxOutputTokens,
      thinkingLevel: keepThinkingLevel(model.thinkingLevel ?? "off", known),
    },
    notice: "",
  };
}

/** A new Wisp needs a model it can run: the global default or its own, with a saved provider key. */
export function isWispModelDraftInvalid(draft: WispModelDraft, view: AiSettingsView | null): boolean {
  if (!view) return true;
  if (draft.useGlobal) return missingModelSetup(view).length > 0;
  if (!draft.providerId || !draft.modelId) return true;
  const provider = view.providers.find(({ id }) => id === draft.providerId);
  if (!provider?.credentialConfigured) return true;
  const model = provider.models.find(({ id }) => id === draft.modelId);
  return invalidMaxOutputTokens(draft.maxOutputTokens, model?.maxOutputTokens);
}

const GLOBAL_MODEL = "global";

interface CreateWispModelSectionProps {
  view: AiSettingsView | null;
  loadError: string;
  draft: WispModelDraft;
  onChange: (draft: WispModelDraft) => void;
  /** Why an imported template's model was not selected. */
  notice?: string;
}

function CreateWispModelSection({ view, loadError, draft, onChange, notice }: CreateWispModelSectionProps) {
  const selection = draft.useGlobal ? null : { providerId: draft.providerId, modelId: draft.modelId };
  const provider = selection ? view?.providers.find(({ id }) => id === selection.providerId) : undefined;
  const model = selection && view ? catalogModel(view, selection) : undefined;
  const value = selection ? modelOptionValue(selection) : GLOBAL_MODEL;
  const globalModel = view?.selection ?? null;
  const options = view
    ? [
        {
          value: GLOBAL_MODEL,
          label: "Use the global model",
          description: globalModel ? modelName(view, globalModel) : "None is set in Settings → AI Model",
          iconSrc: globalModel ? modelLabLogo(globalModel) : undefined,
        },
        ...modelOptions(view),
      ]
    : [];
  // A template's model from a provider without a saved key stays selected until one is added.
  if (view && selection && model && !options.some((option) => option.value === value)) {
    options.push({
      value,
      label: model.name,
      description: `${provider?.name ?? selection.providerId} · ${selection.modelId}`,
      iconSrc: modelLabLogo(selection),
    });
  }

  function choose(next: string): void {
    if (next === value) return;
    if (next === GLOBAL_MODEL) {
      onChange({ ...draft, useGlobal: true });
      return;
    }
    if (!view || !isModelOptionValue(next)) return;
    const nextSelection = parseModelOptionValue(next);
    onChange({
      useGlobal: false,
      ...nextSelection,
      maxOutputTokens: "",
      thinkingLevel: keepThinkingLevel(draft.thinkingLevel, catalogModel(view, nextSelection)),
    });
  }

  return (
    <SettingsCard className="mt-[15px]">
      <SettingsRow className="min-h-0 p-[11px]">
        <SettingsRowCopy>
          <SettingsRowTitle htmlFor="create-wisp-model">Model</SettingsRowTitle>
          <SettingsRowDescription>
            {draft.useGlobal ? "Follows Settings → AI Model." : "Specific to this Wisp."}
          </SettingsRowDescription>
          {model && !model.input.includes("image") ? <NoImageInputNote /> : null}
        </SettingsRowCopy>
        <SearchableCombobox
          id="create-wisp-model"
          value={value}
          options={options}
          disabled={!view}
          className="h-8 w-[260px] max-w-[62%] text-base"
          searchLabel="Search models"
          searchPlaceholder="Search model name or ID…"
          emptyText="No models from providers with a saved key."
          onChange={choose}
        />
      </SettingsRow>
      {notice ? (
        <p role="status" className="m-0 px-3.5 pb-3 text-xs text-dim">
          {notice}
        </p>
      ) : null}
      {!view && loadError ? (
        <p role="alert" className="m-0 px-3.5 pb-3 text-xs text-destructive">
          {loadError}
        </p>
      ) : null}
      {draft.useGlobal && view && missingModelSetup(view).length > 0 ? (
        <p role="alert" className="m-0 px-3.5 pb-3 text-xs text-destructive">
          {view.selection
            ? "No API key is saved for the global default provider. Add one in Settings → AI Model, or choose a model for this Wisp."
            : "No global default model is set. Choose one in Settings → AI Model, or choose a model for this Wisp."}
        </p>
      ) : null}
      {canChooseThinkingLevel(model) ? (
        <ThinkingLevelRow
          id="create-wisp-thinking-level"
          className="min-h-0 p-[11px]"
          model={model}
          value={keepThinkingLevel(draft.thinkingLevel, model)}
          onChange={(thinkingLevel) => onChange({ ...draft, thinkingLevel })}
        />
      ) : null}
      {provider && !provider.credentialConfigured ? (
        <p role="alert" className="m-0 px-3.5 pb-3 text-xs text-destructive">
          {provider.id === CLAUDE_CODE_PROVIDER
            ? `${claudeCodeUnavailableMessage(view?.claudeCode)} See Settings → AI Model.`
            : `No API key saved for ${provider.name} yet. Add one in Settings → AI Model before creating this Wisp.`}
        </p>
      ) : null}
    </SettingsCard>
  );
}

export { CreateWispModelSection };
