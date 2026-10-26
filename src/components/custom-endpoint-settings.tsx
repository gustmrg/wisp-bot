import { useState } from "react";

import type { AiSettingsView } from "../../shared/contracts";
import {
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS,
  MAX_CUSTOM_ENDPOINT_MODELS,
  type CustomEndpointModel,
  type CustomEndpointView,
  type DetectedEndpoint,
} from "../../shared/custom-endpoints";
import {
  ConfirmAction,
  SettingsActions,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

interface CustomEndpointSettingsProps {
  view: AiSettingsView;
  onViewChange: (view: AiSettingsView) => void;
  /** Called after an endpoint is added, so its models can be chosen at once. */
  onCreated?: (view: AiSettingsView, endpointId: string) => void;
}

/** A form's starting point: a saved endpoint, a server found on the computer, or nothing. */
type Editing = { endpoint: CustomEndpointView } | { detected: DetectedEndpoint } | { blank: true };

function modelCount(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`;
}

/**
 * Endpoints the person adds that speak the OpenAI API, such as Ollama or
 * LM Studio (ADR 031). Each one becomes a provider whose models every
 * picker offers.
 */
export function CustomEndpointSettings({ view, onViewChange, onCreated }: CustomEndpointSettingsProps) {
  const endpoints = view.customEndpoints ?? [];
  const [editing, setEditing] = useState<Editing | null>(null);
  const [detected, setDetected] = useState<ReadonlyArray<DetectedEndpoint> | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDetect(): Promise<void> {
    setDetecting(true);
    setError(null);
    try {
      const result = await window.wisp.detectLocalEndpoints();
      if (result.ok) setDetected(result.value.endpoints);
      else setError(result.error.message);
    } catch {
      setError("Could not look for local model servers.");
    } finally {
      setDetecting(false);
    }
  }

  if (editing) {
    const saved = "endpoint" in editing ? editing.endpoint : undefined;
    return (
      <CustomEndpointForm
        endpoint={saved}
        detected={"detected" in editing ? editing.detected : undefined}
        secureStorageAvailable={view.secureStorageAvailable}
        onSaved={(nextView) => {
          setEditing(null);
          onViewChange(nextView);
          if (!saved) {
            const created = nextView.customEndpoints?.find(
              ({ id }) => !endpoints.some((endpoint) => endpoint.id === id),
            );
            if (created) onCreated?.(nextView, created.id);
          }
        }}
        onRemoved={(nextView) => {
          setEditing(null);
          onViewChange(nextView);
        }}
        onBack={() => setEditing(null)}
      />
    );
  }

  return (
    <SettingsGroup label="Custom endpoints">
      <SettingsCard variant="stacked">
        {endpoints.length === 0 ? (
          <SettingsRow>
            <SettingsRowCopy>
              <SettingsRowDescription>
                Add a server that speaks the OpenAI API, such as Ollama, LM Studio, vLLM, llama.cpp, or a proxy. Its
                models then appear in every model picker.
              </SettingsRowDescription>
            </SettingsRowCopy>
          </SettingsRow>
        ) : null}
        {endpoints.map((endpoint) => (
          <SettingsRow key={endpoint.id}>
            <SettingsRowCopy>
              <SettingsRowTitle>{endpoint.name}</SettingsRowTitle>
              <SettingsRowDescription className="break-all">
                {endpoint.baseUrl} · {modelCount(endpoint.models.length)} ·{" "}
                {endpoint.keySaved ? "API key saved" : "No API key"}
              </SettingsRowDescription>
            </SettingsRowCopy>
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              aria-label={`Edit ${endpoint.name}`}
              onClick={() => setEditing({ endpoint })}
            >
              Edit
            </Button>
          </SettingsRow>
        ))}
      </SettingsCard>
      <SettingsActions className="mt-2">
        <Button type="button" variant="secondary" onClick={() => setEditing({ blank: true })}>
          Add endpoint
        </Button>
        <Button type="button" variant="ghost" disabled={detecting} onClick={() => void handleDetect()}>
          {detecting ? "Looking…" : "Find local servers"}
        </Button>
      </SettingsActions>
      {error ? (
        <p role="alert" className="m-0 mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {detected ? (
        <DetectedEndpoints
          detected={detected}
          added={endpoints}
          onAdd={(endpoint) => setEditing({ detected: endpoint })}
        />
      ) : null}
    </SettingsGroup>
  );
}

function DetectedEndpoints({
  detected,
  added,
  onAdd,
}: {
  detected: ReadonlyArray<DetectedEndpoint>;
  added: ReadonlyArray<CustomEndpointView>;
  onAdd: (endpoint: DetectedEndpoint) => void;
}) {
  if (!detected.length) {
    return (
      <p role="status" className="m-0 mt-2 text-xs leading-relaxed text-dim">
        No model server answered at the usual addresses of Ollama, LM Studio, vLLM, or llama.cpp on the computer that
        runs Wisp.
      </p>
    );
  }
  return (
    <SettingsCard variant="stacked" className="mt-2" role="status" aria-label="Local model servers found">
      {detected.map((endpoint) => {
        const already = added.some(({ baseUrl }) => baseUrl === endpoint.baseUrl);
        return (
          <SettingsRow key={endpoint.baseUrl}>
            <SettingsRowCopy>
              <SettingsRowTitle>{endpoint.name}</SettingsRowTitle>
              <SettingsRowDescription className="break-all">
                {endpoint.baseUrl} · {modelCount(endpoint.models.length)}
              </SettingsRowDescription>
            </SettingsRowCopy>
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              disabled={already}
              aria-label={already ? `${endpoint.name} is added` : `Add ${endpoint.name}`}
              onClick={() => onAdd(endpoint)}
            >
              {already ? "Added" : "Add"}
            </Button>
          </SettingsRow>
        );
      })}
    </SettingsCard>
  );
}

/** A model as the form edits it: numbers stay text until saved, so a field can be cleared while typing. */
interface ModelDraft {
  id: string;
  contextWindow: string;
  maxOutputTokens: string;
  images: boolean;
}

function newModel(id: string): ModelDraft {
  return {
    id,
    contextWindow: String(DEFAULT_CUSTOM_CONTEXT_WINDOW),
    maxOutputTokens: String(DEFAULT_CUSTOM_MAX_OUTPUT_TOKENS),
    images: false,
  };
}

function modelDraft(model: CustomEndpointModel): ModelDraft {
  return {
    id: model.id,
    contextWindow: String(model.contextWindow),
    maxOutputTokens: String(model.maxOutputTokens),
    images: model.images,
  };
}

function savedModel(draft: ModelDraft): CustomEndpointModel {
  return {
    id: draft.id,
    contextWindow: Number(draft.contextWindow),
    maxOutputTokens: Number(draft.maxOutputTokens),
    images: draft.images,
  };
}

function CustomEndpointForm({
  endpoint,
  detected,
  secureStorageAvailable,
  onSaved,
  onRemoved,
  onBack,
}: {
  endpoint?: CustomEndpointView;
  detected?: DetectedEndpoint;
  secureStorageAvailable: boolean;
  onSaved: (view: AiSettingsView) => void;
  onRemoved: (view: AiSettingsView) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(endpoint?.name ?? detected?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? detected?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [models, setModels] = useState<ModelDraft[]>(
    endpoint?.models.map(modelDraft) ?? detected?.models.slice(0, MAX_CUSTOM_ENDPOINT_MODELS).map(newModel) ?? [],
  );
  const [listed, setListed] = useState<ReadonlyArray<string> | null>(detected?.models ?? null);
  const [newModelId, setNewModelId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const included = new Set(models.map(({ id }) => id));
  const unlisted = models.filter(({ id }) => !listed?.includes(id));

  function changed(): void {
    setError(null);
  }

  function toggleModel(id: string): void {
    setModels((current) =>
      current.some((model) => model.id === id)
        ? current.filter((model) => model.id !== id)
        : [...current, newModel(id)],
    );
    changed();
  }

  function updateModel(id: string, change: Partial<ModelDraft>): void {
    setModels((current) => current.map((model) => (model.id === id ? { ...model, ...change } : model)));
    changed();
  }

  function addModelById(): void {
    const id = newModelId.trim();
    if (!id) return;
    if (!included.has(id)) setModels((current) => [...current, newModel(id)]);
    setNewModelId("");
    changed();
  }

  async function handleLoadModels(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await window.wisp.loadCustomEndpointModels({
        baseUrl,
        ...(apiKey.trim() ? { apiKey } : {}),
        ...(endpoint && !removeKey ? { id: endpoint.id } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setListed(result.value.models);
      // A new endpoint starts with every model it lists; an edited one keeps its choice.
      if (!endpoint && models.length === 0) {
        setModels(result.value.models.slice(0, MAX_CUSTOM_ENDPOINT_MODELS).map(newModel));
      }
    } catch {
      setError("Could not load the endpoint's models.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const result = await window.wisp.saveCustomEndpoint({
        ...(endpoint ? { id: endpoint.id } : {}),
        name,
        baseUrl,
        ...(apiKey.trim() ? { apiKey } : {}),
        ...(removeKey ? { removeKey: true } : {}),
        models: models.map(savedModel),
      });
      if (result.ok) onSaved(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not save the endpoint.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(): Promise<void> {
    if (!endpoint) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.wisp.removeCustomEndpoint({ id: endpoint.id });
      if (result.ok) onRemoved(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not remove the endpoint.");
    } finally {
      setSaving(false);
    }
  }

  const keyHint = removeKey
    ? "The saved key is removed when you save."
    : endpoint?.keySaved
      ? "An encrypted key is saved. Enter a new one to replace it."
      : "Optional. Local servers usually need none. The key is encrypted and sent to this address only.";

  return (
    <SettingsGroup label={endpoint ? `Edit ${endpoint.name}` : "Add a custom endpoint"}>
      <SettingsCard variant="stacked">
        <SettingsRow className="max-[620px]:flex-col max-[620px]:items-stretch">
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="custom-endpoint-name">Name</SettingsRowTitle>
            <SettingsRowDescription>Shown in model pickers.</SettingsRowDescription>
          </SettingsRowCopy>
          <Input
            id="custom-endpoint-name"
            value={name}
            placeholder="Ollama"
            className="w-[260px] max-w-full"
            onChange={(event) => {
              setName(event.currentTarget.value);
              changed();
            }}
          />
        </SettingsRow>
        <SettingsRow className="max-[620px]:flex-col max-[620px]:items-stretch">
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="custom-endpoint-url">Address</SettingsRowTitle>
            <SettingsRowDescription>
              The base URL of its OpenAI API, as seen from the computer that runs Wisp.
            </SettingsRowDescription>
          </SettingsRowCopy>
          <Input
            id="custom-endpoint-url"
            value={baseUrl}
            placeholder="http://127.0.0.1:11434/v1"
            inputMode="url"
            className="w-[260px] max-w-full"
            onChange={(event) => {
              setBaseUrl(event.currentTarget.value);
              changed();
            }}
          />
        </SettingsRow>
        <div className="flex flex-col gap-3 px-3.5 py-3.5">
          <div className="flex flex-wrap items-start gap-3">
            <SettingsRowCopy>
              <SettingsRowTitle htmlFor="custom-endpoint-key">API key</SettingsRowTitle>
              <SettingsRowDescription>{keyHint}</SettingsRowDescription>
            </SettingsRowCopy>
            {endpoint?.keySaved ? (
              <Button
                type="button"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  setRemoveKey((current) => !current);
                  setApiKey("");
                  changed();
                }}
              >
                {removeKey ? "Keep key" : "Remove key"}
              </Button>
            ) : null}
          </div>
          <SecretInput
            id="custom-endpoint-key"
            autoComplete="new-password"
            value={apiKey}
            disabled={!secureStorageAvailable || removeKey}
            placeholder={endpoint?.keySaved && !removeKey ? "Saved — enter a replacement" : "No key"}
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              changed();
            }}
          />
        </div>
      </SettingsCard>

      <div className="mx-0.5 mb-[7px] mt-[18px] flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 text-xs font-normal text-dim">Models</h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading || !baseUrl.trim()}
          onClick={() => void handleLoadModels()}
        >
          {loading ? "Loading…" : "Load models"}
        </Button>
      </div>
      <SettingsCard variant="stacked">
        {listed?.map((id) => (
          <ModelRow
            key={id}
            id={id}
            model={models.find((model) => model.id === id)}
            onToggle={() => toggleModel(id)}
            onChange={(change) => updateModel(id, change)}
          />
        ))}
        {unlisted.map((model) => (
          <ModelRow
            key={model.id}
            id={model.id}
            model={model}
            onToggle={() => toggleModel(model.id)}
            onChange={(change) => updateModel(model.id, change)}
          />
        ))}
        {listed?.length === 0 ? (
          <SettingsRow>
            <SettingsRowDescription>The endpoint lists no models. Add one by its ID below.</SettingsRowDescription>
          </SettingsRow>
        ) : null}
        <SettingsRow className="max-[620px]:flex-col max-[620px]:items-stretch">
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="custom-endpoint-model-id">Add a model by ID</SettingsRowTitle>
            <SettingsRowDescription>
              For a model the endpoint does not list, such as qwen2.5-coder:7b.
            </SettingsRowDescription>
          </SettingsRowCopy>
          <div className="flex gap-2">
            <Input
              id="custom-endpoint-model-id"
              value={newModelId}
              className="w-[200px] max-w-full"
              onChange={(event) => setNewModelId(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addModelById();
                }
              }}
            />
            <Button type="button" variant="secondary" disabled={!newModelId.trim()} onClick={addModelById}>
              Add
            </Button>
          </div>
        </SettingsRow>
      </SettingsCard>
      <p className="m-0 mt-1.5 px-0.5 text-xs leading-relaxed text-dim">
        Wisps use tools, so choose models that support tool calling. Set the context window to what the server allows:
        Ollama, for one, uses a small window unless it is configured for a larger one.
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div aria-live="polite">{error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}</div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" disabled={saving} onClick={onBack}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || !name.trim() || !baseUrl.trim() || models.length === 0}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save endpoint"}
          </Button>
        </div>
      </div>
      {endpoint ? (
        <div className="mt-4 flex justify-start">
          <ConfirmAction
            label="Remove endpoint"
            confirmLabel="Remove endpoint"
            variant="ghost"
            disabled={saving}
            description={`Wisps using ${endpoint.name} stop working until you choose another model.`}
            onConfirm={() => void handleRemove()}
          />
        </div>
      ) : null}
    </SettingsGroup>
  );
}

function ModelRow({
  id,
  model,
  onToggle,
  onChange,
}: {
  id: string;
  model: ModelDraft | undefined;
  onToggle: () => void;
  onChange: (change: Partial<ModelDraft>) => void;
}) {
  const fieldId = `custom-endpoint-model-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <div className="flex flex-col gap-2.5 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <SettingsRowCopy>
          <SettingsRowTitle className="break-all font-mono text-xs">{id}</SettingsRowTitle>
        </SettingsRowCopy>
        <ToggleSwitch checked={Boolean(model)} label={`Offer ${id}`} onChange={onToggle} />
      </div>
      {model ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-dim" htmlFor={`${fieldId}-context`}>
            Context window
            <Input
              id={`${fieldId}-context`}
              type="number"
              min={1}
              step={1}
              value={model.contextWindow}
              className="w-[130px]"
              onChange={(event) => onChange({ contextWindow: event.currentTarget.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim" htmlFor={`${fieldId}-output`}>
            Maximum output tokens
            <Input
              id={`${fieldId}-output`}
              type="number"
              min={1}
              step={1}
              value={model.maxOutputTokens}
              className="w-[130px]"
              onChange={(event) => onChange({ maxOutputTokens: event.currentTarget.value })}
            />
          </label>
          <div className="flex items-center gap-2 pb-1.5 text-xs text-dim">
            <ToggleSwitch
              checked={model.images}
              label={`${id} accepts images`}
              onChange={() => onChange({ images: !model.images })}
            />
            Accepts images
          </div>
        </div>
      ) : null}
    </div>
  );
}
