import { useEffect, useState } from "react";

import { PreferenceSwitch, SettingsSelect, type SettingsOption } from "@/components/general-settings-sections";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AppPreferences } from "@/lib/app-preferences";
import { formatShortcut } from "@/lib/shortcuts";
import {
  defaultVoiceModel,
  isVoiceLanguage,
  isVoiceProviderId,
  VOICE_LANGUAGES,
  VOICE_PROVIDERS,
  voiceProvider,
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
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("Could not save the API key.");
    } finally {
      setSaving(false);
    }
  }

  /** The key is the one AI Model settings use, so removing it here removes it there too. */
  async function handleRemoveKey(): Promise<void> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const removed = await window.wisp.removeProviderCredential({ providerId: provider.id });
      if (!removed.ok) {
        setError(removed.error.message);
        return;
      }
      const result = await window.wisp.getVoiceSettings();
      if (result.ok) setView(result.value);
      else setError(result.error.message);
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
        <SettingsGroup label="Recording">
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <label htmlFor="voice-microphone">
                  <strong>Microphone</strong>
                </label>
                <small>Device names appear after Wisp first uses the microphone.</small>
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
                <strong>Send automatically</strong>
                <small>
                  {preferences.voiceAutoSend
                    ? "The message is sent as soon as it is transcribed."
                    : "The transcript waits in the composer so you can review it before sending."}
                </small>
              </SettingsRowCopy>
              <PreferenceSwitch
                label="Send automatically"
                checked={preferences.voiceAutoSend}
                onChange={() => onPreferencesChange({ ...preferences, voiceAutoSend: !preferences.voiceAutoSend })}
              />
            </SettingsRow>
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup label="Transcription">
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <label htmlFor="voice-provider">
                  <strong>Provider</strong>
                </label>
                <small>The speech-to-text service that transcribes your recordings.</small>
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
                <label htmlFor="voice-model">
                  <strong>Model</strong>
                </label>
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
                <label htmlFor="voice-language">
                  <strong>Language</strong>
                </label>
                <small>Choosing the language you speak improves accuracy.</small>
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

        <SettingsGroup label="Credential">
          <SettingsCard>
            <div className="flex flex-col gap-3 px-3.5 py-3.5">
              <SettingsRowCopy>
                <label htmlFor="voice-api-key">
                  <strong>{provider.name} API key</strong>
                </label>
                <small>
                  {providerStatus?.credentialConfigured
                    ? `An encrypted key is saved for ${provider.name} and shared with AI Model settings. Enter a new key to replace it.`
                    : `Add a ${provider.name} key to use voice input. It is encrypted using your operating system's credential storage.`}
                </small>
              </SettingsRowCopy>
              <div className="flex gap-2">
                <Input
                  id="voice-api-key"
                  type="password"
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
          {providerStatus?.credentialConfigured ? (
            <ConfirmAction
              label="Remove key"
              confirmLabel="Remove key"
              disabled={saving}
              description={`Voice input and Wisps using ${provider.name} stop working until you enter a new key.`}
              onConfirm={() => void handleRemoveKey()}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

export { VoiceSettingsSection };
