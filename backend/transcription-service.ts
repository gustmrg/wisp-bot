import {
  VOICE_PROVIDERS,
  voiceProvider,
  type SaveVoiceCredentialRequest,
  type TranscribeAudioRequest,
  type TranscriptionResult,
  type VoiceSettingsView,
} from "../shared/voice.js";
import { WispBackendError } from "./backend-error.js";
import type { ModelService } from "./model-service.js";
import type { StructuredLogger } from "./structured-logger.js";

const TRANSCRIPTION_TIMEOUT_MS = 60_000;

type VoiceCredentials = Pick<
  ModelService,
  "getApiKey" | "setApiKey" | "listCredentialProviders" | "isSecureStorageAvailable"
>;

interface TranscriptionServiceOptions {
  credentials: VoiceCredentials;
  fetch?: typeof fetch;
  logger?: Pick<StructuredLogger, "warn">;
  timeoutMs?: number;
}

const FILE_EXTENSIONS: Record<TranscribeAudioRequest["mimeType"], string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
};

/**
 * Sends recorded audio to a cloud speech-to-text provider. Runs in the main
 * process so API keys never reach the renderer, whose CSP also blocks network
 * access.
 */
export class TranscriptionService {
  private readonly credentials: VoiceCredentials;
  private readonly fetch: typeof fetch;
  private readonly logger: Pick<StructuredLogger, "warn"> | undefined;
  private readonly timeoutMs: number;
  private readonly inFlight = new Set<AbortController>();

  constructor(options: TranscriptionServiceOptions) {
    this.credentials = options.credentials;
    this.fetch = options.fetch ?? fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS;
  }

  async getView(): Promise<VoiceSettingsView> {
    const configured = await this.credentials.listCredentialProviders();
    return {
      secureStorageAvailable: this.credentials.isSecureStorageAvailable(),
      providers: VOICE_PROVIDERS.map((provider) => ({
        id: provider.id,
        name: provider.name,
        credentialConfigured: configured.has(provider.id),
      })),
    };
  }

  async saveCredential(request: SaveVoiceCredentialRequest): Promise<VoiceSettingsView> {
    await this.credentials.setApiKey(request.providerId, request.apiKey);
    return this.getView();
  }

  async transcribe(request: TranscribeAudioRequest): Promise<TranscriptionResult> {
    const provider = voiceProvider(request.providerId);
    if (!provider) throw new WispBackendError("invalid_request", "The voice provider is invalid.");
    const apiKey = await this.credentials.getApiKey(provider.id);
    if (!apiKey) {
      throw new WispBackendError(
        "configuration_required",
        `Add a ${provider.name} API key in Settings to use voice input.`,
      );
    }

    const form = new FormData();
    form.append(
      "file",
      // A copy, because the IPC buffer may be shared and Blob takes only plain ArrayBuffers.
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType }),
      `recording.${FILE_EXTENSIONS[request.mimeType]}`,
    );
    form.append("model", request.modelId);
    if (request.language !== "auto") form.append("language", request.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.inFlight.add(controller);
    let response: Response;
    try {
      response = await this.fetch(provider.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch {
      throw new WispBackendError(
        "model_unavailable",
        controller.signal.aborted
          ? `${provider.name} took too long to transcribe the recording.`
          : `Could not reach ${provider.name}. Check your connection and try again.`,
        true,
      );
    } finally {
      clearTimeout(timeout);
      this.inFlight.delete(controller);
    }

    if (!response.ok) {
      this.logger?.warn("transcription_failed", { providerId: provider.id, status: response.status });
      throw transcriptionError(provider.name, response.status);
    }
    const body = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
    if (typeof body?.text !== "string") {
      throw new WispBackendError("model_unavailable", `${provider.name} returned an unexpected response.`, true);
    }
    return { text: body.text.trim() };
  }

  /** Cancels transcriptions still waiting on a provider; used on shutdown. */
  dispose(): void {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
  }
}

function transcriptionError(providerName: string, status: number): WispBackendError {
  if (status === 401 || status === 403) {
    return new WispBackendError(
      "configuration_required",
      `${providerName} rejected the API key. Update it in Settings to use voice input.`,
    );
  }
  if (status === 413) {
    return new WispBackendError("invalid_request", "The recording is too long to transcribe. Try a shorter one.");
  }
  if (status === 429) {
    return new WispBackendError(
      "model_unavailable",
      `${providerName} is rate limiting requests. Wait a moment and try again.`,
      true,
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new WispBackendError("invalid_configuration", `${providerName} could not transcribe this recording.`);
  }
  return new WispBackendError("model_unavailable", `${providerName} could not transcribe the recording.`, true);
}

/** Stands in for a provider in fake agent mode, so voice input works without keys or network. */
export function fakeTranscriptionFetch(text = "This is a fake transcription."): typeof fetch {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response(JSON.stringify({ text }), { headers: { "Content-Type": "application/json" } });
  };
}
