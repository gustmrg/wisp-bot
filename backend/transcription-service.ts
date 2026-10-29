import {
  VOICE_PROVIDERS,
  voiceProvider,
  type RemoveVoiceCredentialRequest,
  type SaveVoiceCredentialRequest,
  type TranscribeAudioRequest,
  type TranscriptionResult,
  type VoiceModelChoice,
  type VoiceSettingsView,
} from "../shared/voice.js";
import { WispBackendError } from "./backend-error.js";
import type { ModelService } from "./model-service.js";
import type { StructuredLogger } from "./structured-logger.js";

const TRANSCRIPTION_TIMEOUT_MS = 60_000;
/** How long one provider gets when a fallback waits behind it. */
const FALLBACK_ATTEMPT_TIMEOUT_MS = 30_000;

type VoiceCredentials = Pick<
  ModelService,
  "getVoiceKey" | "saveVoiceKey" | "removeVoiceKey" | "listVoiceKeys" | "isSecureStorageAvailable"
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
    // Transcription needs a key: a subscription sign-in for the same provider does not reach it.
    const keys = await this.credentials.listVoiceKeys();
    return {
      secureStorageAvailable: this.credentials.isSecureStorageAvailable(),
      providers: VOICE_PROVIDERS.map((provider) => {
        const source = keys.get(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          credentialConfigured: source !== undefined,
          ...(source ? { credentialSource: source } : {}),
        };
      }),
    };
  }

  async saveCredential(request: SaveVoiceCredentialRequest): Promise<VoiceSettingsView> {
    await this.credentials.saveVoiceKey(request.providerId, request.apiKey);
    return this.getView();
  }

  async removeCredential(request: RemoveVoiceCredentialRequest): Promise<VoiceSettingsView> {
    await this.credentials.removeVoiceKey(request.providerId);
    return this.getView();
  }

  /**
   * Transcribes with the provider asked for, then with each fallback in turn
   * while a failure is one the next provider may not share (SWE-253). A
   * failure caused by the recording itself ends the chain, and no provider is
   * asked twice, so the same audio is never paid for again where it already
   * failed.
   */
  async transcribe(request: TranscribeAudioRequest): Promise<TranscriptionResult> {
    const chain = uniqueChoices([
      { providerId: request.providerId, modelId: request.modelId },
      ...(request.fallbacks ?? []),
    ]);
    // With a fallback waiting, a provider that hangs gives way sooner.
    const timeoutMs = chain.length > 1 ? Math.min(this.timeoutMs, FALLBACK_ATTEMPT_TIMEOUT_MS) : this.timeoutMs;
    const failures: WispBackendError[] = [];
    for (const [index, choice] of chain.entries()) {
      try {
        const text = await this.transcribeWith(choice, request, timeoutMs);
        return { text, providerId: choice.providerId, modelId: choice.modelId };
      } catch (error) {
        if (!(error instanceof WispBackendError) || !movesToNextProvider(error)) throw error;
        failures.push(error);
        const next = chain[index + 1];
        if (next) {
          this.logger?.warn("transcription_fallback", {
            providerId: choice.providerId,
            nextProviderId: next.providerId,
            code: error.code,
          });
        }
      }
    }
    throw chainError(chain, failures);
  }

  private async transcribeWith(
    choice: VoiceModelChoice,
    request: TranscribeAudioRequest,
    timeoutMs: number,
  ): Promise<string> {
    const provider = voiceProvider(choice.providerId);
    if (!provider) throw new WispBackendError("invalid_request", "The voice provider is invalid.");
    const apiKey = await this.credentials.getVoiceKey(provider.id);
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
    form.append("model", choice.modelId);
    if (request.language !== "auto") form.append("language", request.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      this.logger?.warn("transcription_failed", {
        providerId: provider.id,
        status: controller.signal.aborted ? "timeout" : "network",
      });
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
    return body.text.trim();
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
  if (status === 402) {
    return new WispBackendError(
      "configuration_required",
      `${providerName} has no credit left for this API key. Add credit or use another key.`,
    );
  }
  if (status === 404) {
    return new WispBackendError("model_unavailable", `${providerName} does not offer this transcription model.`);
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
  if (status === 400 || status === 422) {
    return new WispBackendError("invalid_configuration", `${providerName} could not transcribe this recording.`);
  }
  return new WispBackendError("model_unavailable", `${providerName} could not transcribe the recording.`, true);
}

/**
 * Whether another provider may succeed where this one failed: it could not be
 * reached, timed out, was rate limited or down, or has no usable key or credit.
 * A recording that is empty, too long, or unreadable fails everywhere.
 */
function movesToNextProvider(error: WispBackendError): boolean {
  return error.code === "model_unavailable" || error.code === "configuration_required";
}

/** What the person is told when every provider failed: the one asked for, unless a fallback was tried too. */
function chainError(
  chain: ReadonlyArray<VoiceModelChoice>,
  failures: ReadonlyArray<WispBackendError>,
): WispBackendError {
  const [first] = failures;
  if (!first || failures.length === 1)
    return first ?? new WispBackendError("model_unavailable", "Could not transcribe the recording.", true);
  // Only keys and credit left: the fix is in Settings.
  if (failures.every((failure) => failure.code === "configuration_required")) return first;
  const names = chain.map(({ providerId }) => voiceProvider(providerId)?.name ?? providerId);
  return new WispBackendError(
    "model_unavailable",
    `None of your voice providers could transcribe the recording (${names.join(", ")}). Try again.`,
    true,
  );
}

/** The chain without repeats, so a fallback equal to the provider before it is not asked again. */
function uniqueChoices(choices: ReadonlyArray<VoiceModelChoice>): VoiceModelChoice[] {
  const seen = new Set<string>();
  return choices.filter(({ providerId, modelId }) => {
    const key = `${providerId}:${modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Stands in for a provider in fake agent mode, so voice input works without keys or network. */
export function fakeTranscriptionFetch(text = "This is a fake transcription."): typeof fetch {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response(JSON.stringify({ text }), { headers: { "Content-Type": "application/json" } });
  };
}
