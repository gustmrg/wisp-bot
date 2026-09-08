import { useBackendApi } from "@/features/backend/backend-provider";
import { useEffect, useState } from "react";
import type { ConversationModelView, ModelSelection } from "../../shared/contracts";

export function modelName(model: ModelSelection | null | undefined): string {
  return model ? `${model.providerId} / ${model.modelId}` : "Not configured";
}

export function useConversationModel(conversationId: string | null) {
  const api = useBackendApi();
  const [view, setView] = useState<{ id: string; model: ConversationModelView } | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      try {
        const result = await api.getConversationModel({ conversationId });
        if (active && current === revision && result.ok) setView({ id: conversationId, model: result.value });
      } catch {
        // The composer uses the conversation status to gate sending even if metadata cannot load.
      }
    };
    const unsubscribe = api.subscribeToAgentEvents((event) => {
      if (
        event.conversationId === conversationId &&
        (event.type === "conversation_model_changed" || event.type === "conversation_status")
      )
        void load();
    });
    void load();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, conversationId]);
  return view?.id === conversationId ? view.model : null;
}
