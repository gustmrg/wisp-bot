import { CLAUDE_CODE_PROVIDER } from "../../shared/claude-code";
import type { AiSettingsView, ModelSelection } from "../../shared/contracts";
import { modelLabLogo } from "@/lib/model-lab";

/** Ids never hold control characters, so one joins provider and model into an option value. */
export function modelOptionValue({ providerId, modelId }: ModelSelection): string {
  return `${providerId}\u001f${modelId}`;
}

export function parseModelOptionValue(value: string): ModelSelection {
  const [providerId = "", modelId = ""] = value.split("\u001f");
  return { providerId, modelId };
}

export function isModelOptionValue(value: string): boolean {
  return value.includes("\u001f");
}

/**
 * One option per model of a provider with a saved key that `include` accepts,
 * labelled for a model picker. Claude Code, which needs no key, is listed while
 * it is ready; `claudeCode: false` leaves it out of pickers for models that
 * run on Pi, such as the fallback and image models (ADR 026).
 */
export function modelOptions(
  view: AiSettingsView,
  include: (model: AiSettingsView["providers"][number]["models"][number]) => boolean = () => true,
  { claudeCode = true }: { claudeCode?: boolean } = {},
): Array<{ value: string; label: string; description: string; iconSrc: string | undefined }> {
  return view.providers
    .filter(({ id, credentialConfigured }) => credentialConfigured && (claudeCode || id !== CLAUDE_CODE_PROVIDER))
    .flatMap((provider) =>
      provider.models.filter(include).map((model) => ({
        value: modelOptionValue({ providerId: provider.id, modelId: model.id }),
        label: model.name,
        description: `${provider.name} · ${model.id}`,
        iconSrc: modelLabLogo({ providerId: provider.id, modelId: model.id }),
      })),
    );
}

/** A saved model that is no longer offered, so the picker can still show it. */
export function unavailableModelOption(
  view: AiSettingsView,
  selection: ModelSelection,
): { value: string; label: string; description: string; iconSrc: string | undefined } {
  return {
    value: modelOptionValue(selection),
    iconSrc: modelLabLogo(selection),
    label: `${selection.modelId} (unavailable)`,
    description: view.providers.find(({ id }) => id === selection.providerId)?.name ?? selection.providerId,
  };
}

/** A model's catalog entry, or undefined when the catalog no longer lists it. */
export function catalogModel(
  view: AiSettingsView,
  selection: ModelSelection,
): AiSettingsView["providers"][number]["models"][number] | undefined {
  return view.providers
    .find(({ id }) => id === selection.providerId)
    ?.models.find(({ id }) => id === selection.modelId);
}

/** An entered maximum output tokens that is not a whole number from 1 to the model's limit; empty means automatic. */
export function invalidMaxOutputTokens(value: string, modelMax: number | undefined): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parsed = Number(trimmed);
  return !Number.isSafeInteger(parsed) || parsed < 1 || parsed > (modelMax ?? 1_000_000);
}

/** The catalog name of a model, or its ID when the catalog no longer lists it. */
export function modelName(view: AiSettingsView, selection: ModelSelection): string {
  return catalogModel(view, selection)?.name ?? selection.modelId;
}
