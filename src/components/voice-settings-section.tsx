import { useEffect, useState } from "react";

import { PreferenceSwitch, SettingsSelect, type SettingsOption } from "@/components/general-settings-sections";
import { SearchableCombobox } from "@/components/searchable-combobox";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { SettingsScopeNote } from "@/components/settings/settings-scope";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/ui/secret-input";
import type { AppPreferences } from "@/lib/app-preferences";
import { formatShortcut } from "@/lib/shortcuts";
import { notifyProviderCredentialsChanged } from "@/lib/voice-credentials";
import {
  defaultVoiceModel,
  isVoiceLanguage,
  isVoiceModel,
  isVoiceProviderId,
  VOICE_LANGUAGES,
  VOICE_PROVIDERS,
  voiceProvider,
  type VoiceModelChoice,
  type VoiceSettingsView,
} from "../../shared/voice";

interface VoiceSettingsSectionProps {
  active: boolean;
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}

const PROVIDER_OPTIONS: SettingsOption[] = VOICE_PROVIDERS.map((provider) => ({
  value: provider.id,
  label: provider.name,
}));
const LANGUAGE_OPTIONS: SettingsOption[] = VOICE_LANGUAGES.map((language) => ({ ...language }));

/** Input devices the browser already exposes; never asks for recording permission. */
function useMicrophones(active: boolean): SettingsOption[] {
  const [microphones, setMicrophones] = useState<SettingsOption[]>([]);
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!active || !mediaDevices?.enumerateDevices) return;
    let current = true;
    let request = 0;
    async function refreshMicrophones() {
      const version = ++request;
      try {
        const devices = await mediaDevices.enumerateDevices();
        if (!current || version !== request) return;
        setMicrophones(
          devices
            .filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default")
            .map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
        );
      } catch {
        if (current && version === request) setMicrophones([]);
      }
    }
    void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", refreshMicrophones);
    return () => {
      current = false;
      mediaDevices.removeEventListener("devicechange", refreshMicrophones);
    };
  }, [active]);
  return microphones;
}

function VoiceSettingsSection({ active, preferences, onPreferencesChange }: VoiceSettingsSectionProps) {
  const microphones = useMicrophones(active);
  const [view, setView] = useState<VoiceSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.wisp
      .getVoiceSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setView(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load voice settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const provider = voiceProvider(preferences.voiceProvider) ?? VOICE_PROVIDERS[0];
  const providerStatus = view?.providers.find(({ id }) => id === provider.id);
  const modelOptions: SettingsOption[] = provider.models.map((model) => ({ value: model.id, label: model.name }));
  const microphoneOptions = [{ value: "default", label: "System Default" }, ...microphones];
  if (!microphoneOptions.some((option) => option.value === preferences.microphone)) {
    microphoneOptions.push({ value: preferences.microphone, label: "Saved microphone (unavailable)" });
  }

  async function handleSaveKey(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.saveVoiceCredential({ providerId: provider.id, apiKey });
      if (result.ok) {
        setView(result.value);
        setApiKey("");
        setSaved(true);
        notifyProviderCredentialsChanged();
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("Could not save the API key.");
    } finally {
      setSaving(false);
    }
  }

  /** A shared key is the one AI Model settings use, so removing it here removes it there too. */
  async function handleRemoveKey(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await window.wisp.removeVoiceCredential({ providerId: provider.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setView(result.value);
      notifyProviderCredentialsChanged();
    } catch {
      setError("Could not remove the API key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="voice-settings-panel"
      aria-labelledby="voice-settings-title"
      hidden={!active}
    >
      <h2 id="voice-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Voice input
      </h2>
      <p className="mb-[22px] text-dim text-xs leading-relaxed">
        Dictate messages with the microphone button or {formatShortcut(preferences.shortcuts.voiceInput)}. Recordings
        are sent to the provider below for transcription and are not stored.
      </p>
      <div className="animate-tab-forward">
        <SettingsGroup label="Recording" note={<SettingsScopeNote scope="device" />}>
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle htmlFor="voice-microphone">Microphone</SettingsRowTitle>
                <SettingsRowDescription>
                  Device names appear after Wisp first uses the microphone.
                </SettingsRowDescription>
              </SettingsRowCopy>
              <SettingsSelect
                id="voice-microphone"
                value={preferences.microphone}
                options={microphoneOptions}
                onChange={(microphone) => onPreferencesChange({ ...preferences, microphone })}
              />
            </SettingsRow>
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle>Send automatically</SettingsRowTitle>
                <SettingsRowDescription>
                  {preferences.voiceAutoSend
                    ? "The message is sent as soon as it is transcribed."
                    : "The transcript waits in the composer so you can review it before sending."}
                </SettingsRowDescription>
              </SettingsRowCopy>
              <PreferenceSwitch
                label="Send automatically"
                checked={preferences.voiceAutoSend}
                onChange={() => onPreferencesChange({ ...preferences, voiceAutoSend: !preferences.voiceAutoSend })}
              />
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup label="Transcription" note={<SettingsScopeNote scope="device" />}>
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle htmlFor="voice-provider">Provider</SettingsRowTitle>
                <SettingsRowDescription>
                  The speech-to-text service that transcribes your recordings.
                </SettingsRowDescription>
              </SettingsRowCopy>
              <SettingsSelect
                id="voice-provider"
                value={provider.id}
                options={PROVIDER_OPTIONS}
                onChange={(value) => {
                  if (!isVoiceProviderId(value)) return;
                  onPreferencesChange({ ...preferences, voiceProvider: value, voiceModel: defaultVoiceModel(value) });
                  setApiKey("");
                  setError(null);
                  setSaved(false);
                }}
              />
            </SettingsRow>
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle htmlFor="voice-model">Model</SettingsRowTitle>
              </SettingsRowCopy>
              <SettingsSelect
                id="voice-model"
                value={preferences.voiceModel}
                options={modelOptions}
                onChange={(voiceModel) => onPreferencesChange({ ...preferences, voiceModel })}
              />
            </SettingsRow>
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle htmlFor="voice-language">Language</SettingsRowTitle>
                <SettingsRowDescription>Choosing the language you speak improves accuracy.</SettingsRowDescription>
              </SettingsRowCopy>
              <SettingsSelect
                id="voice-language"
                value={preferences.voiceLanguage}
                options={LANGUAGE_OPTIONS}
                onChange={(value) => {
                  if (isVoiceLanguage(value)) onPreferencesChange({ ...preferences, voiceLanguage: value });
                }}
              />
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup label="Credential" note={<SettingsScopeNote scope="environment" />}>
          <SettingsCard>
            <div className="flex flex-col gap-3 px-3.5 py-3.5">
              <div className="flex flex-wrap items-start gap-3">
                <SettingsRowCopy>
                  <SettingsRowTitle htmlFor="voice-api-key">{provider.name} API key</SettingsRowTitle>
                  <SettingsRowDescription>
                    {providerStatus?.credentialSource === "voice"
                      ? `An encrypted key is saved for ${provider.name} voice input only; AI Model settings use your sign-in. Enter a new key to replace it.`
                      : providerStatus?.credentialConfigured
                        ? `An encrypted key is saved for ${provider.name} and shared with AI Model settings. Enter a new key to replace it.`
                        : `Add a ${provider.name} key to use voice input. It is encrypted using your operating system's credential storage.`}
                  </SettingsRowDescription>
                </SettingsRowCopy>
                {providerStatus?.credentialConfigured ? (
                  <ConfirmAction
                    label="Remove key"
                    confirmLabel="Remove key"
                    variant="ghost"
                    className="shrink-0"
                    disabled={saving}
                    description={
                      providerStatus.credentialSource === "voice"
                        ? `Voice input with ${provider.name} stops working until you enter a new key. Your sign-in is kept.`
                        : `Voice input and Wisps using ${provider.name} stop working until you enter a new key.`
                    }
                    onConfirm={() => void handleRemoveKey()}
                  />
                ) : null}
              </div>
              <div className="flex gap-2">
                <SecretInput
                  id="voice-api-key"
                  autoComplete="new-password"
                  value={apiKey}
                  disabled={view ? !view.secureStorageAvailable : true}
                  placeholder={providerStatus?.credentialConfigured ? "Saved — enter a replacement" : "Enter API key"}
                  onChange={(event) => {
                    setApiKey(event.currentTarget.value);
                    setError(null);
                    setSaved(false);
                  }}
                />
                <Button type="button" disabled={saving || !apiKey.trim()} onClick={() => void handleSaveKey()}>
                  {saving ? "Saving…" : "Save key"}
                </Button>
              </div>
              {view && !view.secureStorageAvailable ? (
                <p className="m-0 text-xs leading-relaxed text-destructive">
                  Secure credential storage is unavailable. Wisp will not save an API key as plaintext.
                </p>
              ) : null}
            </div>
          </SettingsCard>
        </SettingsGroup>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div aria-live="polite">
            {error ? <p className="m-0 text-xs text-destructive">{error}</p> : null}
            {saved ? <p className="m-0 text-xs text-dim">{provider.name} key saved.</p> : null}
          </div>
        </div>

        <FallbackVoiceModel view={view} preferences={preferences} onPreferencesChange={onPreferencesChange} />
      </div>
    </section>
  );
}

const OFF = "off";

const choiceValue = ({ providerId, modelId }: VoiceModelChoice) => `${providerId}:${modelId}`;

function choiceOf(value: string): VoiceModelChoice | undefined {
  const separator = value.indexOf(":");
  const providerId = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  return isVoiceProviderId(providerId) && isVoiceModel(providerId, modelId) ? { providerId, modelId } : undefined;
}

function modelOption({ providerId, modelId }: VoiceModelChoice) {
  const provider = voiceProvider(providerId);
  const model = provider?.models.find(({ id }) => id === modelId);
  return {
    value: choiceValue({ providerId, modelId }),
    label: model?.name ?? modelId,
    description: `${provider?.name ?? providerId} · ${modelId}`,
  };
}

/**
 * Chooses the model a recording goes to when the provider above cannot
 * transcribe it (SWE-253), like the fallback model in AI Model. Only models
 * from other providers with a saved key are listed: a provider that is down,
 * rate limited, or refusing its key fails all of its models at once.
 */
function FallbackVoiceModel({
  view,
  preferences,
  onPreferencesChange,
}: {
  view: VoiceSettingsView | null;
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
}) {
  const selected = preferences.voiceFallback;
  const keyed = new Set((view?.providers ?? []).filter((status) => status.credentialConfigured).map(({ id }) => id));
  const primaryName = voiceProvider(preferences.voiceProvider)?.name ?? preferences.voiceProvider;
  const options = [
    { value: OFF, label: "Off", description: "Voice input stops when the provider fails" },
    ...VOICE_PROVIDERS.filter(({ id }) => keyed.has(id) && id !== preferences.voiceProvider).flatMap((provider) =>
      provider.models.map((model) => modelOption({ providerId: provider.id, modelId: model.id })),
    ),
  ];
  if (selected && !options.some(({ value }) => value === choiceValue(selected))) {
    const option = modelOption(selected);
    options.push({ ...option, label: `${option.label} (unavailable)` });
  }
  const providerName = selected ? (voiceProvider(selected.providerId)?.name ?? selected.providerId) : "";
  // Said only once the keys are known, so the warning never flashes while they load.
  const unavailable =
    !selected || !view
      ? null
      : !keyed.has(selected.providerId)
        ? `Add an API key for ${providerName} to use this model. Until then, voice input has no fallback.`
        : selected.providerId === preferences.voiceProvider
          ? `This model is from ${primaryName}, the provider above, so it fails along with it. Choose a model from another provider.`
          : null;
  return (
    <SettingsGroup label="Fallback" note={<SettingsScopeNote scope="device" />}>
      <SettingsCard>
        <SettingsRow>
          <SettingsRowCopy>
            <SettingsRowTitle htmlFor="voice-fallback-model">Fallback model</SettingsRowTitle>
            <SettingsRowDescription>
              Transcribes the recording when the provider above fails for a reason another may not share: it can't be
              reached, takes too long, is rate limited, or rejects its key. A recording no provider could read is not
              sent again. Only models from other providers with a saved key are listed.
            </SettingsRowDescription>
            {unavailable ? (
              <span role="alert" className="text-xs leading-relaxed text-warning">
                {unavailable}
              </span>
            ) : null}
          </SettingsRowCopy>
          <SearchableCombobox
            id="voice-fallback-model"
            value={selected ? choiceValue(selected) : OFF}
            options={options}
            className="h-8 w-[260px] max-w-[62%] text-base"
            searchLabel="Search fallback models"
            searchPlaceholder="Search model name or ID…"
            emptyText="No models from providers with a saved key."
            onChange={(value) =>
              onPreferencesChange({ ...preferences, voiceFallback: value === OFF ? null : (choiceOf(value) ?? null) })
            }
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsGroup>
  );
}

export { VoiceSettingsSection };
