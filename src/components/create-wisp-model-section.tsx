import type { AiSettingsView, ModelSelection } from "../../shared/contracts";
import { SettingsCard, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export interface WispModelDraft {
  useGlobal: boolean;
  providerId: string;
  modelId: string;
  maxOutputTokens: string;
}

export function createDefaultWispModelDraft(): WispModelDraft {
  return { useGlobal: true, providerId: "", modelId: "", maxOutputTokens: "" };
}

export function resolveWispModelSelection(draft: WispModelDraft): ModelSelection | null {
  if (draft.useGlobal || !draft.providerId || !draft.modelId) return null;
  const maxOutputTokens = draft.maxOutputTokens.trim();
  return {
    providerId: draft.providerId,
    modelId: draft.modelId,
    ...(maxOutputTokens ? { maxOutputTokens: Number(maxOutputTokens) } : {}),
  };
}

function invalidMaxOutputTokens(draft: WispModelDraft, modelMax: number | undefined): boolean {
  const value = draft.maxOutputTokens.trim();
  if (!value) return false;
  const parsed = Number(value);
  return !Number.isSafeInteger(parsed) || parsed < 1 || parsed > (modelMax ?? 1_000_000);
}

export function isWispModelDraftInvalid(draft: WispModelDraft, view: AiSettingsView | null): boolean {
  if (draft.useGlobal) return false;
  if (!draft.providerId || !draft.modelId) return true;
  const model = view?.providers
    .find(({ id }) => id === draft.providerId)
    ?.models.find(({ id }) => id === draft.modelId);
  return invalidMaxOutputTokens(draft, model?.maxOutputTokens);
}

function globalSummary(view: AiSettingsView | null): string {
  const selection = view?.selection;
  if (!selection) return "No global default configured yet";
  const provider = view?.providers.find(({ id }) => id === selection.providerId);
  return `Global default · ${provider?.name ?? selection.providerId} ${selection.modelId}`;
}

interface CreateWispModelSectionProps {
  view: AiSettingsView | null;
  loadError: string;
  draft: WispModelDraft;
  onChange: (draft: WispModelDraft) => void;
}

function CreateWispModelSection({ view, loadError, draft, onChange }: CreateWispModelSectionProps) {
  const catalog = view?.providers ?? [];
  const provider = catalog.find(({ id }) => id === draft.providerId);
  const model = provider?.models.find(({ id }) => id === draft.modelId);
  const canCustomize = catalog.length > 0;

  function switchMode(nextUseGlobal: boolean): void {
    if (nextUseGlobal) {
      onChange({ ...draft, useGlobal: true });
      return;
    }
    const selection = view?.selection;
    const nextProvider = catalog.find(({ id }) => id === selection?.providerId) ?? catalog[0];
    onChange({
      useGlobal: false,
      providerId: nextProvider?.id ?? "",
      modelId:
        nextProvider && selection && nextProvider.id === selection.providerId
          ? selection.modelId
          : (nextProvider?.models[0]?.id ?? ""),
      maxOutputTokens: "",
    });
  }

  function handleProviderChange(nextProviderId: string | null): void {
    if (!nextProviderId) return;
    const nextProvider = catalog.find(({ id }) => id === nextProviderId);
    const selection = view?.selection;
    onChange({
      ...draft,
      providerId: nextProviderId,
      modelId:
        selection && selection.providerId === nextProviderId ? selection.modelId : (nextProvider?.models[0]?.id ?? ""),
      maxOutputTokens: "",
    });
  }

  return (
    <SettingsCard className="mt-[15px]">
      <SettingsRow className="min-h-0 p-[11px]">
        <SettingsRowCopy>
          <strong className="text-[12.5px]">Model</strong>
          <small className="text-dim text-[11px] leading-[1.3]">
            {draft.useGlobal ? globalSummary(view) : "Specific to this Wisp"}
          </small>
        </SettingsRowCopy>
        <ToggleSwitch
          checked={!draft.useGlobal}
          label="Choose model for this Wisp"
          onChange={() => (canCustomize ? switchMode(!draft.useGlobal) : undefined)}
        />
      </SettingsRow>
      {draft.useGlobal && !canCustomize && loadError ? (
        <p role="alert" className="m-0 px-3.5 pb-3 text-[11px] text-destructive">
          {loadError}
        </p>
      ) : null}
      {draft.useGlobal && view && !canCustomize ? (
        <p className="m-0 px-3.5 pb-3 text-[11px] text-dim">
          No providers are available yet. Set up a provider in Settings → AI Model after creating this Wisp.
        </p>
      ) : null}
      {!draft.useGlobal && view ? (
        <>
          <SettingsRow className="min-h-0 flex-col items-stretch gap-2 p-[11px]">
            <SettingsRowCopy>
              <label htmlFor="create-wisp-provider">
                <strong>Provider</strong>
              </label>
            </SettingsRowCopy>
            <Select
              items={catalog.map(({ id, name }) => ({ value: id, label: name }))}
              value={draft.providerId}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger id="create-wisp-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {catalog.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow className="min-h-0 flex-col items-stretch gap-2 p-[11px]">
            <SettingsRowCopy>
              <label htmlFor="create-wisp-model">
                <strong>Model</strong>
              </label>
              <small>{provider?.models.length ?? 0} models available.</small>
            </SettingsRowCopy>
            <Select
              items={provider?.models.map(({ id, name }) => ({ value: id, label: name })) ?? []}
              value={draft.modelId}
              onValueChange={(value) => {
                if (value !== null) onChange({ ...draft, modelId: value, maxOutputTokens: "" });
              }}
            >
              <SelectTrigger id="create-wisp-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {provider?.models.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow className="min-h-0 flex-col items-stretch gap-2 p-[11px]">
            <SettingsRowCopy>
              <label htmlFor="create-wisp-max-output-tokens">
                <strong>Maximum output tokens</strong>
              </label>
              <small>Leave empty to use the safe automatic limit of up to 32,768 tokens.</small>
            </SettingsRowCopy>
            <Input
              id="create-wisp-max-output-tokens"
              type="number"
              min={1}
              max={model?.maxOutputTokens ?? 1_000_000}
              step={1}
              value={draft.maxOutputTokens}
              placeholder="Automatic"
              className="w-[160px]"
              onChange={(event) => onChange({ ...draft, maxOutputTokens: event.currentTarget.value })}
            />
          </SettingsRow>
          {provider && !provider.credentialConfigured ? (
            <p role="alert" className="m-0 px-3.5 pb-3 text-[11px] text-destructive">
              No API key saved for {provider.name} yet. Add one in Settings → AI Model to let this Wisp send messages.
            </p>
          ) : null}
          {invalidMaxOutputTokens(draft, model?.maxOutputTokens) ? (
            <p role="alert" className="m-0 px-3.5 pb-3 text-[11px] text-destructive">
              Maximum output tokens must be a whole number between 1 and {model?.maxOutputTokens ?? 1_000_000}.
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

export { CreateWispModelSection };
