import { useEffect, useState } from "react";
import { InfoIcon } from "lucide-react";

import type { AiSettingsView, ConversationModelView, ThinkingLevel, WispFallback } from "../../shared/contracts";
import { NoImageInputNote } from "@/components/no-image-input-note";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { SettingsRowTitle } from "@/components/settings/settings-primitives";
import {
  canChooseThinkingLevel,
  keepThinkingLevel,
  THINKING_LEVEL_LABELS,
  ThinkingLevelRow,
} from "@/components/thinking-level-select";
import { imageModelName } from "@/hooks/use-model-image-input";
import {
  isModelOptionValue,
  modelName,
  modelOptions,
  modelOptionValue,
  parseModelOptionValue,
  unavailableModelOption,
} from "@/lib/model-choice";
import { Button } from "@/components/ui/button";

export function WispModelSettings({ conversationId }: { conversationId: string }) {
  const [catalog, setCatalog] = useState<AiSettingsView | null>(null);
  const [view, setView] = useState<ConversationModelView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
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
  const appliedModel = applied ? appliedProvider?.models.find(({ id }) => id === applied.modelId) : undefined;
  const override = view?.override ?? null;
  const overrideModel = override
    ? catalog?.providers.find(({ id }) => id === override.providerId)?.models.find(({ id }) => id === override.modelId)
    : undefined;
  const effective = view?.effective ?? null;
  const effectiveModel = effective
    ? catalog?.providers
        .find(({ id }) => id === effective.providerId)
        ?.models.find(({ id }) => id === effective.modelId)
    : undefined;

  async function changeFallback(fallback: WispFallback): Promise<void> {
    setSaving(true);
    setSaveError("");
    try {
      const result = await window.wisp.applyFallbackModel({ conversationId, fallback });
      if (!result.ok) {
        setSaveError(result.error.message);
        return;
      }
      setLoadRequest({ conversationId });
    } catch {
      setSaveError("Could not change the fallback model.");
    } finally {
      setSaving(false);
    }
  }

  async function changeThinkingLevel(level: ThinkingLevel): Promise<void> {
    if (!override) return;
    const { thinkingLevel: _previous, ...model } = override;
    setSaving(true);
    setSaveError("");
    try {
      const result = await window.wisp.applyModel({
        conversationId,
        model: level === "off" ? model : { ...model, thinkingLevel: level },
      });
      if (!result.ok) {
        setSaveError(result.error.message);
        return;
      }
      setLoadRequest({ conversationId });
    } catch {
      setSaveError("Could not change the reasoning level.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
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
              <h3 className="m-0 text-2xs font-medium uppercase tracking-wide text-dim">Current model</h3>
              {applied ? (
                <>
                  <p className="m-0 mt-1.5 break-words text-base leading-snug font-semibold">
                    {appliedProvider?.name ?? applied.providerId}
                  </p>
                  <p className="m-0 break-all text-dim text-sm leading-snug">{applied.modelId}</p>
                  {appliedModel && !appliedModel.input.includes("image") ? (
                    <NoImageInputNote className="mt-1.5" imageModel={imageModelName(catalog)} />
                  ) : null}
                </>
              ) : (
                <p className="m-0 mt-1.5 text-dim">Not configured</p>
              )}
              {view.pending ? (
                <p className="m-0 mt-2.5 break-all border-t border-border pt-2 text-xs text-dim">
                  Switches to {view.pending.modelId} after this turn
                </p>
              ) : null}
            </section>
            {override && canChooseThinkingLevel(overrideModel) ? (
              <section aria-label="Reasoning" className="rounded-lg border border-border bg-card p-3">
                <ThinkingLevelRow
                  id="wisp-thinking-level"
                  stacked
                  model={overrideModel}
                  value={keepThinkingLevel(override.thinkingLevel ?? "off", overrideModel)}
                  disabled={saving}
                  onChange={(level) => void changeThinkingLevel(level)}
                />
              </section>
            ) : null}
            {/* A server from before fallbacks reports none; it cannot save one either. */}
            {view.fallback && catalog.fallback ? (
              <FallbackSection
                catalog={catalog}
                view={view}
                disabled={saving}
                onChange={(fallback) => void changeFallback(fallback)}
              />
            ) : null}
            {!override && effective && canChooseThinkingLevel(effectiveModel) ? (
              <p className="m-0 text-xs text-dim">
                Reasoning: {THINKING_LEVEL_LABELS[keepThinkingLevel(effective.thinkingLevel ?? "off", effectiveModel)]}{" "}
                — set with the global model in Settings → AI Model.
              </p>
            ) : null}
            {saveError ? (
              <p role="alert" className="m-0 text-destructive">
                {saveError}
              </p>
            ) : null}
            <p className="m-0 flex items-start gap-2 rounded-lg border border-border bg-muted/60 p-2.5 leading-relaxed text-dim">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 flex-none" />
              <span>The model is set when the Wisp is created and can't be changed for now.</span>
            </p>
            {!view.override ? (
              <p className="m-0 text-xs text-dim">
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

const FALLBACK_OFF = "off";
const FALLBACK_GLOBAL = "global";

/** Chooses what answers when the Wisp's model fails for good: nothing, the global fallback, or a model of its own. */
function FallbackSection({
  catalog,
  view,
  disabled,
  onChange,
}: {
  catalog: AiSettingsView;
  view: ConversationModelView;
  disabled: boolean;
  onChange: (fallback: WispFallback) => void;
}) {
  const { fallback, effective } = view;
  const globalFallback = catalog.fallback.selection;
  const value = typeof fallback === "string" ? fallback : modelOptionValue(fallback);
  const options = [
    { value: FALLBACK_OFF, label: "Off", description: "This Wisp stops when its model fails" },
    {
      value: FALLBACK_GLOBAL,
      label: "Use the global fallback",
      description: globalFallback ? modelName(catalog, globalFallback) : "None is set in Settings → AI Model",
    },
    // The Wisp's own model cannot stand in for itself.
    ...modelOptions(catalog).filter((option) => !effective || option.value !== modelOptionValue(effective)),
  ];
  if (typeof fallback === "object" && !options.some((option) => option.value === value)) {
    options.push(unavailableModelOption(catalog, fallback));
  }
  const note =
    fallback !== FALLBACK_GLOBAL
      ? null
      : !globalFallback
        ? "No global fallback is set, so this Wisp stops when its model fails. Choose one in Settings → AI Model."
        : catalog.fallback.unavailable
          ? "The global fallback cannot be used right now. Check it in Settings → AI Model."
          : effective && modelOptionValue(globalFallback) === modelOptionValue(effective)
            ? "The global fallback is this Wisp's own model, so it has no fallback. Choose another model."
            : null;

  return (
    <section aria-label="Fallback model" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <SettingsRowTitle htmlFor="wisp-fallback-model">Fallback model</SettingsRowTitle>
      <SearchableCombobox
        id="wisp-fallback-model"
        value={value}
        options={options}
        disabled={disabled}
        className="h-8 w-full text-base"
        searchLabel="Search fallback models"
        searchPlaceholder="Search model name or ID…"
        emptyText="No models from providers with a saved key."
        onChange={(next) => {
          if (next === value) return;
          onChange(
            next === FALLBACK_OFF || next === FALLBACK_GLOBAL
              ? next
              : isModelOptionValue(next)
                ? parseModelOptionValue(next)
                : FALLBACK_OFF,
          );
        }}
      />
      <p className="m-0 text-xs leading-relaxed text-dim">
        Answers when this Wisp's model fails for good, for example when the provider is out of credits. Each message
        tries the Wisp's model first.
      </p>
      {note ? (
        <p role="alert" className="m-0 text-xs leading-relaxed text-warning">
          {note}
        </p>
      ) : null}
    </section>
  );
}
