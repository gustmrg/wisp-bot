import { useEffect, useState } from "react";

import type { AiSettingsView, ConversationModelView } from "../../shared/contracts";

/**
 * Whether the model a Wisp runs on accepts images, following model changes.
 * Null while unknown, including when the model or catalog cannot be loaded.
 */
export function useModelImageInput(conversationId: string | null): boolean | null {
  const [imageInput, setImageInput] = useState<boolean | null>(null);
  useEffect(() => {
    setImageInput(null);
    if (!conversationId) return;
    let active = true;
    let revision = 0;
    const load = () => {
      const current = ++revision;
      void Promise.all([window.wisp.getConversationModel({ conversationId }), window.wisp.getAiSettings()])
        .then(([model, settings]) => {
          if (!active || current !== revision) return;
          setImageInput(model.ok && settings.ok ? modelImageInput(model.value, settings.value) : null);
        })
        .catch(() => {
          if (active && current === revision) setImageInput(null);
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
  return imageInput;
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
