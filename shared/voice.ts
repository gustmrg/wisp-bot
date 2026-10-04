/**
 * Cloud speech-to-text providers. Each one serves the OpenAI-compatible
 * `/audio/transcriptions` endpoint, and its id matches the model runtime's
 * provider id, so a key saved for chat models also works for voice input.
 */
export const VOICE_PROVIDERS = [
  {
    id: "groq",
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    models: [
      { id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo" },
      { id: "whisper-large-v3", name: "Whisper Large v3" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    models: [
      { id: "gpt-4o-mini-transcribe", name: "GPT-4o mini Transcribe" },
      { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe" },
      { id: "whisper-1", name: "Whisper" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    endpoint: "https://api.mistral.ai/v1/audio/transcriptions",
    models: [{ id: "voxtral-mini-latest", name: "Voxtral Mini Transcribe" }],
  },
] as const;

export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number]["id"];

export const DEFAULT_VOICE_PROVIDER: VoiceProviderId = "groq";

/** ISO-639-1 codes every provider accepts; "auto" lets the provider detect the language. */
export const VOICE_LANGUAGES = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "nl", label: "Nederlands" },
  { value: "ja", label: "日本語" },
  { value: "zh", label: "中文" },
] as const;

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number]["value"];

/** Groq's free tier rejects larger uploads; recordings stop well before this. */
export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_VOICE_RECORDING_SECONDS = 5 * 60;
export const VOICE_AUDIO_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"] as const;

export type VoiceAudioMimeType = (typeof VOICE_AUDIO_MIME_TYPES)[number];

export interface VoiceProviderStatus {
  id: VoiceProviderId;
  name: string;
  credentialConfigured: boolean;
}

export interface VoiceSettingsView {
  secureStorageAvailable: boolean;
  providers: ReadonlyArray<VoiceProviderStatus>;
}

export interface SaveVoiceCredentialRequest {
  providerId: VoiceProviderId;
  apiKey: string;
}

export interface TranscribeAudioRequest {
  providerId: VoiceProviderId;
  modelId: string;
  language: VoiceLanguage;
  /** The container type without codec parameters. */
  mimeType: VoiceAudioMimeType;
  audio: Uint8Array;
}

export interface TranscriptionResult {
  text: string;
}

export function voiceProvider(id: string): (typeof VOICE_PROVIDERS)[number] | undefined {
  return VOICE_PROVIDERS.find((provider) => provider.id === id);
}

export function isVoiceProviderId(value: unknown): value is VoiceProviderId {
  return typeof value === "string" && voiceProvider(value) !== undefined;
}

export function isVoiceModel(providerId: VoiceProviderId, modelId: unknown): modelId is string {
  return voiceProvider(providerId)?.models.some((model) => model.id === modelId) ?? false;
}

export function defaultVoiceModel(providerId: VoiceProviderId): string {
  return voiceProvider(providerId)?.models[0]?.id ?? VOICE_PROVIDERS[0].models[0].id;
}

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return VOICE_LANGUAGES.some((language) => language.value === value);
}
