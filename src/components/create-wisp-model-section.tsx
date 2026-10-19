import type { AiSettingsView, ModelSelection, ThinkingLevel } from "../../shared/contracts";
import { missingModelSetup } from "../../shared/setup-status";
import { NoImageInputNote } from "@/components/no-image-input-note";
import { canChooseThinkingLevel, keepThinkingLevel, ThinkingLevelRow } from "@/components/thinking-level-select";
import {
  SettingsCard,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { invalidMaxOutputTokens } from "@/lib/model-choice";

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

function globalSummary(view: AiSettingsView | null): string {
  const selection = view?.selection;
  if (!selection) return "No global default configured yet";
  const provider = view?.providers.find(({ id }) => id === selection.providerId);
  return `Global default · ${provider?.name ?? selection.providerId} ${selection.modelId}`;
}

interface CreateWispModelSectionProps {
  view: AiSettingsView | null;
  loadError: string;
  draft: WispModelDraft;
  onChange: (draft: WispModelDraft) => void;
  /** Why an imported template's model was not selected. */
  notice?: string;
}

function CreateWispModelSection({ view, loadError, draft, onChange, notice }: CreateWispModelSectionProps) {
  const catalog = view?.providers ?? [];
  const provider = catalog.find(({ id }) => id === draft.providerId);
  const model = provider?.models.find(({ id }) => id === draft.modelId);
  const canCustomize = catalog.length > 0;

  function switchMode(nextUseGlobal: boolean): void {
    if (nextUseGlobal) {
      onChange({ ...draft, useGlobal: true });
      return;
    }
    const selection = view?.selection;
    const nextProvider = catalog.find(({ id }) => id === selection?.providerId) ?? catalog[0];
    onChange({
      useGlobal: false,
      providerId: nextProvider?.id ?? "",
      modelId:
        nextProvider && selection && nextProvider.id === selection.providerId
          ? selection.modelId
          : (nextProvider?.models[0]?.id ?? ""),
      maxOutputTokens: "",
      thinkingLevel: "off",
    });
  }

  function handleProviderChange(nextProviderId: string | null): void {
    if (!nextProviderId) return;
    const nextProvider = catalog.find(({ id }) => id === nextProviderId);
    const selection = view?.selection;
    const modelId =
      selection && selection.providerId === nextProviderId ? selection.modelId : (nextProvider?.models[0]?.id ?? "");
    onChange({
      ...draft,
      providerId: nextProviderId,
      modelId,
      maxOutputTokens: "",
      thinkingLevel: keepThinkingLevel(
        draft.thinkingLevel,
        nextProvider?.models.find(({ id }) => id === modelId),
      ),
    });
  }

  return (
    <SettingsCard className="mt-[15px]">
      <SettingsRow className="min-h-0 p-[11px]">
        <SettingsRowCopy>
          <SettingsRowTitle>Model</SettingsRowTitle>
          <SettingsRowDescription>
            {draft.useGlobal ? globalSummary(view) : "Specific to this Wisp"}
          </SettingsRowDescription>
        </SettingsRowCopy>
        <ToggleSwitch
          checked={!draft.useGlobal}
          label="Choose model for this Wisp"
          onChange={() => (canCustomize ? switchMode(!draft.useGlobal) : undefined)}
        />
      </SettingsRow>
      {notice ? (
        <p role="status" className="m-0 px-3.5 pb-3 text-xs text-dim">
          {notice}
        </p>
      ) : null}
      {draft.useGlobal && !canCustomize && loadError ? (
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
      {!draft.useGlobal && view ? (
        <>
          <SettingsRow className="min-h-0 p-[11px]">
            <SettingsRowCopy>
              <SettingsRowTitle htmlFor="create-wisp-provider">Provider</SettingsRowTitle>
            </SettingsRowCopy>
            <Select
              items={catalog.map(({ id, name }) => ({ value: id, label: name }))}
              value={draft.providerId}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger id="create-wisp-provider" className="w-[220px] max-w-[55%]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {catalog.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow className="min-h-0 p-[11px]">
            <SettingsRowCopy>
              <SettingsRowTitle htmlFor="create-wisp-model">Model</SettingsRowTitle>
              <SettingsRowDescription>{provider?.models.length ?? 0} models available.</SettingsRowDescription>
              {model && !model.input.includes("image") ? <NoImageInputNote /> : null}
            </SettingsRowCopy>
            <Select
              items={provider?.models.map(({ id, name }) => ({ value: id, label: name })) ?? []}
              value={draft.modelId}
              onValueChange={(value) => {
                if (value === null) return;
                const next = provider?.models.find(({ id }) => id === value);
                onChange({
                  ...draft,
                  modelId: value,
                  maxOutputTokens: "",
                  thinkingLevel: keepThinkingLevel(draft.thinkingLevel, next),
                });
              }}
            >
              <SelectTrigger id="create-wisp-model" className="w-[220px] max-w-[55%]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {provider?.models.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
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
              No API key saved for {provider.name} yet. Add one in Settings → AI Model before creating this Wisp.
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

export { CreateWispModelSection };
