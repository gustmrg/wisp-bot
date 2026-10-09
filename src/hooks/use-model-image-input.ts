import { useEffect, useState } from "react";

import type { AiSettingsView, ConversationModelView } from "../../shared/contracts";

export interface ModelVision {
  /** Whether the Wisp's model accepts images; null while unknown. */
  imageInput: boolean | null;
  /** The auxiliary image model that reads images for it, when one is chosen and usable. */
  imageModel: string | null;
}

const UNKNOWN: ModelVision = { imageInput: null, imageModel: null };

/**
 * Whether the model a Wisp runs on accepts images, and which image model reads
 * them otherwise, following model changes. Unknown while loading, including
 * when the model or catalog cannot be loaded.
 */
export function useModelVision(conversationId: string | null): ModelVision {
  const [vision, setVision] = useState<ModelVision>(UNKNOWN);
  useEffect(() => {
    setVision(UNKNOWN);
    if (!conversationId) return;
    let active = true;
    let revision = 0;
    const load = () => {
      const current = ++revision;
      void Promise.all([window.wisp.getConversationModel({ conversationId }), window.wisp.getAiSettings()])
        .then(([model, settings]) => {
          if (!active || current !== revision) return;
          setVision(
            model.ok && settings.ok
              ? { imageInput: modelImageInput(model.value, settings.value), imageModel: imageModelName(settings.value) }
              : UNKNOWN,
          );
        })
        .catch(() => {
          if (active && current === revision) setVision(UNKNOWN);
        });
    };
    let unsubscribe = () => {};
    try {
      load();
      unsubscribe = window.wisp.subscribeToAgentEvents((event) => {
        if (event.conversationId === conversationId && event.type === "conversation_model_changed") load();
      });
    } catch {
      // Without the app bridge there is nothing to report.
    }
    return () => {
      active = false;
      unsubscribe();
    };
  }, [conversationId]);
  return vision;
}

/** Image input of the model that will answer the Wisp's next message; null when the catalog lacks it. */
export function modelImageInput(view: ConversationModelView, catalog: AiSettingsView): boolean | null {
  const selection = view.pending ?? view.applied ?? view.effective;
  if (!selection) return null;
  const model = catalog.providers
    .find(({ id }) => id === selection.providerId)
    ?.models.find(({ id }) => id === selection.modelId);
  return model ? model.input.includes("image") : null;
}

/** The usable auxiliary image model as "Model (Provider)", matching the read tool's label; null when off or unavailable. */
export function imageModelName(catalog: AiSettingsView): string | null {
  const slot = catalog.auxiliary?.imageUnderstanding;
  if (!slot?.selection || slot.unavailable) return null;
  const { providerId, modelId } = slot.selection;
  const provider = catalog.providers.find(({ id }) => id === providerId);
  const model = provider?.models.find(({ id }) => id === modelId);
  return `${model?.name ?? modelId} (${provider?.name ?? providerId})`;
}
