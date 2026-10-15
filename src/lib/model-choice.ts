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

/** The catalog name of a model, or its ID when the catalog no longer lists it. */
export function modelName(view: AiSettingsView, selection: ModelSelection): string {
  return (
    view.providers.find(({ id }) => id === selection.providerId)?.models.find(({ id }) => id === selection.modelId)
      ?.name ?? selection.modelId
  );
}
