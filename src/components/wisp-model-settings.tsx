import { useEffect, useState } from "react";

import type {
  AiSettingsView,
  ConversationModelView,
  ModelSelection,
  ThinkingLevel,
  WispFallback,
} from "../../shared/contracts";
import { CLAUDE_CODE_PROVIDER, claudeCodeUnavailableMessage } from "../../shared/claude-code";
import { AdvancedSettings } from "@/components/advanced-settings";
import { LogoTile } from "@/components/logo-tile";
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
  catalogModel,
  invalidMaxOutputTokens,
  isModelOptionValue,
  modelName,
  modelOptions,
  modelOptionValue,
  parseModelOptionValue,
  unavailableModelOption,
} from "@/lib/model-choice";
import { modelLabLogo } from "@/lib/model-lab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function WispModelSettings({ conversationId }: { conversationId: string }) {
  const [catalog, setCatalog] = useState<AiSettingsView | null>(null);
  const [view, setView] = useState<ConversationModelView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [loadRequest, setLoadRequest] = useState({ conversationId });
  // How large the conversation is, to warn about models with a smaller context window.
  const [contextTokens, setContextTokens] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void window.wisp
      .manageContext({ conversationId, command: { action: "get" } })
      .then((result) => {
        if (active && result.ok) setContextTokens(result.value.tokens);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [conversationId]);

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
  const appliedModel = applied && catalog ? catalogModel(catalog, applied) : undefined;
  const override = view?.override ?? null;
  const overrideModel = override && catalog ? catalogModel(catalog, override) : undefined;
  const effective = view?.effective ?? null;
  const effectiveModel = effective && catalog ? catalogModel(catalog, effective) : undefined;

  async function saveModel(model: ModelSelection | null, failure: string): Promise<void> {
    setSaving(true);
    setSaveError("");
    try {
      const result = await window.wisp.applyModel({ conversationId, model });
      if (!result.ok) {
        setSaveError(result.error.message);
        return;
      }
      setLoadRequest({ conversationId });
    } catch {
      setSaveError(failure);
    } finally {
      setSaving(false);
    }
  }

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
    await saveModel(
      level === "off" ? model : { ...model, thinkingLevel: level },
      "Could not change the reasoning level.",
    );
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
                  <div className="mt-1.5 flex items-center gap-2.5">
                    <LogoTile src={modelLabLogo(applied)} className="size-8 rounded-lg p-1 empty:hidden" />
                    <div className="min-w-0">
                      <p className="m-0 break-words text-base leading-snug font-semibold">
                        {appliedModel?.name ?? applied.modelId}
                      </p>
                      <p className="m-0 break-all text-dim text-sm leading-snug">
                        {appliedProvider?.name ?? applied.providerId} · {applied.modelId}
                      </p>
                    </div>
                  </div>
                  {appliedModel && !appliedModel.input.includes("image") ? (
                    <NoImageInputNote className="mt-1.5" imageModel={imageModelName(catalog)} />
                  ) : null}
                </>
              ) : (
                <p className="m-0 mt-1.5 text-dim">Not configured</p>
              )}
              {!override ? (
                <p className="m-0 mt-1.5 text-xs leading-relaxed text-dim">
                  This Wisp follows the global model — changes in Settings → AI Model also apply here.
                </p>
              ) : null}
              {view.pending ? (
                <p className="m-0 mt-2.5 break-all border-t border-border pt-2 text-xs text-dim">
                  Switches to {modelName(catalog, view.pending)} after this turn
                </p>
              ) : null}
            </section>
            <ModelSection
              catalog={catalog}
              view={view}
              contextTokens={contextTokens}
              disabled={saving}
              onChange={(model) => void saveModel(model, "Could not change this Wisp's model.")}
            />
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
            <FallbackSection
              catalog={catalog}
              view={view}
              disabled={saving}
              onChange={(fallback) => void changeFallback(fallback)}
            />
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
            {applied && appliedProvider && !appliedProvider.credentialConfigured ? (
              <p role="alert" className="m-0 text-destructive">
                {appliedProvider.id === CLAUDE_CODE_PROVIDER
                  ? `${claudeCodeUnavailableMessage(catalog?.claudeCode)} See Settings → AI Model.`
                  : "Configure this provider's API key in Settings → AI Model."}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

const GLOBAL_MODEL = "global";

/** Chooses the model this Wisp answers with: the global model, or one of its own. */
function ModelSection({
  catalog,
  view,
  contextTokens,
  disabled,
  onChange,
}: {
  catalog: AiSettingsView;
  view: ConversationModelView;
  contextTokens: number | null;
  disabled: boolean;
  onChange: (model: ModelSelection | null) => void;
}) {
  const { override, effective, applied } = view;
  const value = override ? modelOptionValue(override) : GLOBAL_MODEL;
  const readsImages = applied ? (catalogModel(catalog, applied)?.input.includes("image") ?? false) : false;
  const tooSmall = (selection: ModelSelection | null) => {
    const model = selection ? catalogModel(catalog, selection) : undefined;
    return Boolean(contextTokens && model && model.contextWindow < contextTokens);
  };
  // Shown before choosing, since the switch takes effect at once.
  const warnings = (selection: ModelSelection | null) => {
    const model = selection ? catalogModel(catalog, selection) : undefined;
    return [
      readsImages && model && !model.input.includes("image") ? "No image input" : null,
      tooSmall(selection) ? "Too small for this conversation" : null,
    ].filter((warning) => warning !== null);
  };
  const describe = (description: string, selection: ModelSelection | null) =>
    [description, ...warnings(selection)].join(" · ");
  const globalModel = catalog.selection;
  const options = [
    {
      value: GLOBAL_MODEL,
      label: "Use the global model",
      description: globalModel
        ? describe(modelName(catalog, globalModel), globalModel)
        : "None is set in Settings → AI Model",
      iconSrc: globalModel ? modelLabLogo(globalModel) : undefined,
    },
    ...modelOptions(catalog).map((option) => ({
      ...option,
      description: describe(option.description, parseModelOptionValue(option.value)),
    })),
  ];
  if (override && !options.some((option) => option.value === value)) {
    options.push(unavailableModelOption(catalog, override));
  }

  function choose(next: string): void {
    if (next === value) return;
    if (next === GLOBAL_MODEL) {
      onChange(null);
      return;
    }
    if (!isModelOptionValue(next)) return;
    const selection = parseModelOptionValue(next);
    const model = catalogModel(catalog, selection);
    // Keeps the reasoning the Wisp answers with now and its own limit, where the new model allows them.
    const level = keepThinkingLevel(effective?.thinkingLevel ?? "off", model);
    const limit = override?.maxOutputTokens;
    onChange({
      ...selection,
      ...(limit !== undefined && model && limit <= model.maxOutputTokens ? { maxOutputTokens: limit } : {}),
      ...(level === "off" ? {} : { thinkingLevel: level }),
    });
  }

  return (
    <section aria-label="Model" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <SettingsRowTitle htmlFor="wisp-model">Model</SettingsRowTitle>
      <SearchableCombobox
        id="wisp-model"
        value={value}
        options={options}
        disabled={disabled}
        className="h-8 w-full text-base"
        searchLabel="Search models"
        searchPlaceholder="Search model name or ID…"
        emptyText="No models from providers with a saved key."
        onChange={choose}
      />
      {tooSmall(effective) ? (
        <p role="alert" className="m-0 text-xs leading-relaxed text-warning">
          This conversation is larger than this model's context window. Summarize it or start a new topic in Context
          &amp; memory.
        </p>
      ) : null}
      {/* Claude Code manages its own output limit (ADR 026). */}
      {override && override.providerId !== CLAUDE_CODE_PROVIDER ? (
        <AdvancedSettings defaultOpen={override.maxOutputTokens !== undefined}>
          <MaxOutputTokensField
            key={`${modelOptionValue(override)}:${override.maxOutputTokens ?? ""}`}
            override={override}
            modelMax={catalogModel(catalog, override)?.maxOutputTokens}
            disabled={disabled}
            onChange={onChange}
          />
        </AdvancedSettings>
      ) : null}
    </section>
  );
}

/** The Wisp's own limit on each answer, saved when the field is left; empty uses the automatic limit. */
function MaxOutputTokensField({
  override,
  modelMax,
  disabled,
  onChange,
}: {
  override: ModelSelection;
  modelMax: number | undefined;
  disabled: boolean;
  onChange: (model: ModelSelection) => void;
}) {
  const saved = override.maxOutputTokens?.toString() ?? "";
  const [value, setValue] = useState(saved);
  const invalid = invalidMaxOutputTokens(value, modelMax);

  function commit(): void {
    const next = value.trim();
    if (invalid || next === saved) return;
    const { maxOutputTokens: _previous, ...model } = override;
    onChange(next ? { ...model, maxOutputTokens: Number(next) } : model);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <SettingsRowTitle htmlFor="wisp-max-output-tokens">Maximum output tokens</SettingsRowTitle>
      <Input
        id="wisp-max-output-tokens"
        type="number"
        min={1}
        max={modelMax ?? 1_000_000}
        step={1}
        value={value}
        placeholder="Automatic"
        disabled={disabled}
        className="h-8 w-full text-base"
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <p className="m-0 text-xs leading-relaxed text-dim">
        Leave empty to use the safe automatic limit of up to 32,768 tokens.
      </p>
      {invalid ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          Maximum output tokens must be a whole number between 1 and {(modelMax ?? 1_000_000).toLocaleString()}.
        </p>
      ) : null}
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
      iconSrc: globalFallback ? modelLabLogo(globalFallback) : undefined,
    },
    // A failing provider fails with all its models, so none from the Wisp's model's provider is offered.
    ...modelOptions(catalog, undefined, { claudeCode: false }).filter(
      (option) => !effective || parseModelOptionValue(option.value).providerId !== effective.providerId,
    ),
  ];
  if (typeof fallback === "object" && !options.some((option) => option.value === value)) {
    options.push(
      (fallback.providerId !== effective?.providerId &&
        modelOptions(catalog, undefined, { claudeCode: false }).find((option) => option.value === value)) ||
        unavailableModelOption(catalog, fallback),
    );
  }
  const providerName = (providerId: string) =>
    catalog.providers.find(({ id }) => id === providerId)?.name ?? providerId;
  const note =
    fallback !== FALLBACK_GLOBAL
      ? typeof fallback === "object" && effective && fallback.providerId === effective.providerId
        ? `This fallback is from ${providerName(fallback.providerId)}, the provider of this Wisp's model, so it fails along with it. Choose a model from another provider.`
        : null
      : !globalFallback
        ? "No global fallback is set, so this Wisp stops when its model fails. Choose one in Settings → AI Model."
        : effective && globalFallback.providerId === effective.providerId
          ? `The global fallback is from ${providerName(globalFallback.providerId)}, the provider of this Wisp's model, so it fails along with it. Choose a fallback from another provider for this Wisp.`
          : catalog.fallback.unavailable && catalog.fallback.unavailable !== "same_provider"
            ? "The global fallback cannot be used right now. Check it in Settings → AI Model."
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
        emptyText="No models from other providers with a saved key."
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
        tries the Wisp's model first. Only models from another provider are listed.
      </p>
      {note ? (
        <p role="alert" className="m-0 text-xs leading-relaxed text-warning">
          {note}
        </p>
      ) : null}
    </section>
  );
}
