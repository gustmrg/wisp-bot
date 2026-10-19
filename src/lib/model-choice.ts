import type { AiSettingsView, ModelSelection } from "../../shared/contracts";

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

/** One option per model of a provider with a saved key that `include` accepts, labelled for a model picker. */
export function modelOptions(
  view: AiSettingsView,
  include: (model: AiSettingsView["providers"][number]["models"][number]) => boolean = () => true,
): Array<{ value: string; label: string; description: string }> {
  return view.providers
    .filter(({ credentialConfigured }) => credentialConfigured)
    .flatMap((provider) =>
      provider.models.filter(include).map((model) => ({
        value: modelOptionValue({ providerId: provider.id, modelId: model.id }),
        label: model.name,
        description: `${provider.name} · ${model.id}`,
      })),
    );
}

/** A saved model that is no longer offered, so the picker can still show it. */
export function unavailableModelOption(
  view: AiSettingsView,
  selection: ModelSelection,
): { value: string; label: string; description: string } {
  return {
    value: modelOptionValue(selection),
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
