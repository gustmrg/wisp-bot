import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBackendApi } from "@/features/backend/backend-provider";
import { expectedRevision } from "@/features/backend/edit-revision";
import { modelName } from "@/hooks/use-conversation-model";
import type { AiSettingsView, ConversationModelView } from "../../shared/contracts";

export function WispModelSettings({ conversationId }: { conversationId: string }) {
  const api = useBackendApi();
  const formId = useId();
  const [catalog, setCatalog] = useState<AiSettingsView | null>(null);
  const [view, setView] = useState<ConversationModelView | null>(null);
  const [inherit, setInherit] = useState(true);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editRevision, setEditRevision] = useState<number | undefined>();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loadRequest, setLoadRequest] = useState({ conversationId });
  useEffect(() => {
    let active = true;
    setError("");
    setLoading(true);
    void Promise.all([api.getAiSettings(), api.getConversationModel(loadRequest)])
      .then(([settings, model]) => {
        if (!active) return;
        if (!settings.ok) throw new Error(settings.error.message);
        if (!model.ok) throw new Error(model.error.message);
        setCatalog(settings.value);
        setView(model.value);
        setEditRevision(model.value.revision);
        setInherit(model.value.override === null);
        const selection = model.value.override ?? settings.value.selection;
        const provider =
          settings.value.providers.find(({ id }) => id === selection?.providerId) ?? settings.value.providers[0];
        setProviderId(selection?.providerId ?? provider?.id ?? "");
        setModelId(selection?.modelId ?? provider?.models[0]?.id ?? "");
        setLimit(selection?.maxOutputTokens?.toString() ?? "");
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load model settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, loadRequest]);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const unsubscribe = api.subscribeToAgentEvents((event) => {
      if (
        event.conversationId !== conversationId ||
        (event.type !== "conversation_model_changed" && event.type !== "conversation_status")
      )
        return;
      const current = ++revision;
      void Promise.all([api.getConversationModel({ conversationId }), api.getAiSettings()])
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
  }, [api, conversationId]);

  const provider = catalog?.providers.find(({ id }) => id === providerId);
  const model = provider?.models.find(({ id }) => id === modelId);
  const invalidLimit =
    limit !== "" &&
    (!Number.isSafeInteger(Number(limit)) ||
      Number(limit) < 1 ||
      Number(limit) > (model?.maxOutputTokens ?? 1_000_000));
  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await api.applyModel({
        conversationId,
        ...expectedRevision(editRevision),
        model: inherit ? null : { providerId, modelId, ...(limit ? { maxOutputTokens: Number(limit) } : {}) },
      });
      if (!result.ok) throw new Error(result.error.message);
      // Reload both the fields and their revision together after an acknowledged write.
      setLoadRequest({ conversationId });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this Wisp's model.");
    } finally {
      setSaving(false);
    }
  }
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
            <p className="break-words text-dim">
              Current model: {modelName(view.applied)}
              {view.pending ? ` → ${modelName(view.pending)} after this turn` : ""}
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={inherit}
                disabled={saving || loading}
                onChange={(event) => {
                  setInherit(event.target.checked);
                  setSaved(false);
                }}
              />
              Use global model
            </label>
            {inherit ? (
              <p className="break-words text-dim">
                Default: {modelName(catalog.selection)}. Changes to the global model also apply to this Wisp.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${formId}-provider`}>Provider</label>
                  <Select
                    value={providerId}
                    disabled={saving || loading}
                    items={catalog.providers.map((item) => ({
                      value: item.id,
                      label: `${item.name}${item.credentialConfigured ? "" : " (API key required)"}`,
                    }))}
                    onValueChange={(id) => {
                      if (!id) return;
                      setProviderId(id);
                      setModelId(catalog.providers.find((item) => item.id === id)?.models[0]?.id ?? "");
                      setLimit("");
                      setSaved(false);
                    }}
                  >
                    <SelectTrigger id={`${formId}-provider`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      <SelectGroup>
                        {catalog.providers.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                            {item.credentialConfigured ? "" : " (API key required)"}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${formId}-model`}>Model</label>
                  <Select
                    value={modelId}
                    disabled={saving || loading}
                    items={provider?.models.map((item) => ({ value: item.id, label: item.name })) ?? []}
                    onValueChange={(id) => {
                      if (!id) return;
                      setModelId(id);
                      setLimit("");
                      setSaved(false);
                    }}
                  >
                    <SelectTrigger id={`${formId}-model`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      <SelectGroup>
                        {provider?.models.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex flex-col gap-1">
                  Maximum output tokens
                  <Input
                    type="number"
                    min={1}
                    max={model?.maxOutputTokens ?? 1_000_000}
                    placeholder="Automatic"
                    value={limit}
                    disabled={saving || loading}
                    onChange={(event) => {
                      setLimit(event.target.value);
                      setSaved(false);
                    }}
                  />
                </label>
                <p className="text-dim">
                  Uses the provider key saved in Settings → AI Model. No separate key is stored for this Wisp.
                </p>
                {!provider?.credentialConfigured ? (
                  <p className="text-destructive">
                    Configure this provider's API key in Settings → AI Model, then reopen this section.
                  </p>
                ) : null}
              </>
            )}
            <p className="text-dim">A model change takes effect after the current turn finishes.</p>
          </>
        )}
      </div>
      {catalog && view ? (
        <footer className="flex flex-none flex-col gap-3 border-t border-border p-3.5">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p role="status">
              {view.status === "configuration_required"
                ? "Selection saved. Configure the provider before sending messages."
                : "Wisp model saved."}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={saving || loading || (!inherit && (!provider?.credentialConfigured || !model || invalidLimit))}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save model"}
          </Button>
          {error && view ? (
            <Button
              className="mt-2 w-full"
              variant="outline"
              disabled={saving || loading}
              onClick={() => setLoadRequest({ conversationId })}
            >
              Reload server settings
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}
