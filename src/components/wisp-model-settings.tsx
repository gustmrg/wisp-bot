import { useEffect, useState } from "react";
import { InfoIcon } from "lucide-react";

import type { AiSettingsView, ConversationModelView } from "../../shared/contracts";
import { Button } from "@/components/ui/button";

export function WispModelSettings({ conversationId }: { conversationId: string }) {
  const [catalog, setCatalog] = useState<AiSettingsView | null>(null);
  const [view, setView] = useState<ConversationModelView | null>(null);
  const [error, setError] = useState("");
  const [loadRequest, setLoadRequest] = useState({ conversationId });
  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([window.wisp.getAiSettings(), window.wisp.getConversationModel(loadRequest)])
      .then(([settings, model]) => {
        if (!active) return;
        if (!settings.ok) throw new Error(settings.error.message);
        if (!model.ok) throw new Error(model.error.message);
        setCatalog(settings.value);
        setView(model.value);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load model settings.");
      });
    return () => {
      active = false;
    };
  }, [loadRequest]);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const unsubscribe = window.wisp.subscribeToAgentEvents((event) => {
      if (
        event.conversationId !== conversationId ||
        (event.type !== "conversation_model_changed" && event.type !== "conversation_status")
      )
        return;
      const current = ++revision;
      void Promise.all([window.wisp.getConversationModel({ conversationId }), window.wisp.getAiSettings()])
        .then(([model, settings]) => {
          if (!active || current !== revision) return;
          if (model.ok) setView(model.value);
          if (settings.ok) setCatalog(settings.value);
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [conversationId]);

  const applied = view?.applied ?? null;
  const appliedProvider = applied ? catalog?.providers.find(({ id }) => id === applied.providerId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
        {!catalog || !view ? (
          error ? (
            <>
              <p role="alert" className="text-destructive">
                {error}
              </p>
              <Button onClick={() => setLoadRequest({ conversationId })}>Retry</Button>
            </>
          ) : (
            <p role="status">Loading model settings…</p>
          )
        ) : (
          <>
            <section aria-label="Current model" className="rounded-lg border border-border bg-card p-3">
              <h3 className="m-0 text-faint text-[10px] font-medium tracking-[0.08em] uppercase">Current model</h3>
              {applied ? (
                <>
                  <p className="m-0 mt-1.5 break-words text-[13px] leading-snug font-semibold">
                    {appliedProvider?.name ?? applied.providerId}
                  </p>
                  <p className="m-0 break-all text-dim text-[12px] leading-snug">{applied.modelId}</p>
                </>
              ) : (
                <p className="m-0 mt-1.5 text-dim">Not configured</p>
              )}
              {view.pending ? (
                <p className="m-0 mt-2.5 break-all border-t border-border pt-2 text-[11px] text-dim">
                  Switches to {view.pending.modelId} after this turn
                </p>
              ) : null}
            </section>
            <p className="m-0 flex items-start gap-2 rounded-lg border border-border bg-muted/60 p-2.5 leading-relaxed text-dim">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
              <span>The model is set when the Wisp is created and can't be changed for now.</span>
            </p>
            {!view.override ? (
              <p className="m-0 text-[11px] text-dim">
                This Wisp follows the global model — changes in Settings → AI Model also apply here.
              </p>
            ) : null}
            {applied && appliedProvider && !appliedProvider.credentialConfigured ? (
              <p role="alert" className="m-0 text-destructive">
                Configure this provider's API key in Settings → AI Model.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
