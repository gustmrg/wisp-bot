import { describe, expect, it, vi } from "vitest";

import { TranscriptionService } from "../backend/transcription-service.js";
import type { TranscribeAudioRequest, VoiceCredentialSource } from "../shared/voice.js";

function createService(
  options: { keys?: Record<string, string>; voiceOnly?: ReadonlyArray<string>; response?: Response | Error } = {},
) {
  const keys = new Map(Object.entries(options.keys ?? { groq: "groq-key" }));
  const source = (providerId: string): VoiceCredentialSource =>
    options.voiceOnly?.includes(providerId) ? "voice" : "shared";
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const response = options.response ?? Response.json({ text: "  Hello there.  " });
    if (response instanceof Error) throw response;
    return response;
  });
  const credentials = {
    getVoiceKey: vi.fn(async (providerId: string) => keys.get(providerId)),
    saveVoiceKey: vi.fn(async (providerId: string, apiKey: string) => void keys.set(providerId, apiKey)),
    removeVoiceKey: vi.fn(async (providerId: string) => void keys.delete(providerId)),
    listVoiceKeys: vi.fn(async () => new Map([...keys.keys()].map((id) => [id, source(id)]))),
    isSecureStorageAvailable: () => true,
  };
  const service = new TranscriptionService({ credentials, fetch: fetch as unknown as typeof globalThis.fetch });
  return { service, fetch, credentials };
}

const request: TranscribeAudioRequest = {
  providerId: "groq",
  modelId: "whisper-large-v3-turbo",
  language: "pt",
  mimeType: "audio/webm",
  audio: new Uint8Array([1, 2, 3]),
};

describe("TranscriptionService", () => {
  it("posts the recording to the provider with its saved key and trims the text", async () => {
    const { service, fetch } = createService();

    await expect(service.transcribe(request)).resolves.toEqual({ text: "Hello there." });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(init?.headers).toEqual({ Authorization: "Bearer groq-key" });
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("pt");
    const file = form.get("file") as File;
    expect(file.name).toBe("recording.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(3);
  });

  it("leaves language detection to the provider", async () => {
    const { service, fetch } = createService({ keys: { openai: "openai-key" } });

    await service.transcribe({ ...request, providerId: "openai", modelId: "whisper-1", language: "auto" });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init?.body as FormData).has("language")).toBe(false);
  });

  it("asks for a key before calling a provider without one", async () => {
    const { service, fetch } = createService({ keys: {} });

    await expect(service.transcribe(request)).rejects.toMatchObject({
      code: "configuration_required",
      message: "Add a Groq API key in Settings to use voice input.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "configuration_required", false],
    [413, "invalid_request", false],
    [429, "model_unavailable", true],
    [500, "model_unavailable", true],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    const { service } = createService({ response: new Response("{}", { status }) });

    await expect(service.transcribe(request)).rejects.toMatchObject({ code, retryable });
  });

  it("reports network failures and malformed responses as retryable", async () => {
    await expect(
      createService({ response: new TypeError("offline") }).service.transcribe(request),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      retryable: true,
      message: expect.stringContaining("Could not reach Groq"),
    });
    await expect(
      createService({ response: Response.json({ transcript: "?" }) }).service.transcribe(request),
    ).rejects.toMatchObject({ code: "model_unavailable" });
  });

  it("reports which providers have keys and saves new ones", async () => {
    const { service, credentials } = createService();

    expect((await service.getView()).providers).toEqual([
      { id: "groq", name: "Groq", credentialConfigured: true, credentialSource: "shared" },
      { id: "openai", name: "OpenAI", credentialConfigured: false },
      { id: "mistral", name: "Mistral", credentialConfigured: false },
    ]);
    const view = await service.saveCredential({ providerId: "mistral", apiKey: "mistral-key" });

    expect(credentials.saveVoiceKey).toHaveBeenCalledWith("mistral", "mistral-key");
    expect(view.providers.find(({ id }) => id === "mistral")?.credentialConfigured).toBe(true);
  });

  it("transcribes with a key kept for voice input alone and removes it", async () => {
    const { service, fetch, credentials } = createService({ keys: { openai: "voice-key" }, voiceOnly: ["openai"] });

    expect((await service.getView()).providers.find(({ id }) => id === "openai")).toEqual({
      id: "openai",
      name: "OpenAI",
      credentialConfigured: true,
      credentialSource: "voice",
    });
    await service.transcribe({ ...request, providerId: "openai", modelId: "whisper-1" });
    expect(fetch.mock.calls[0]![1]?.headers).toEqual({ Authorization: "Bearer voice-key" });

    const view = await service.removeCredential({ providerId: "openai" });

    expect(credentials.removeVoiceKey).toHaveBeenCalledWith("openai");
    expect(view.providers.find(({ id }) => id === "openai")?.credentialConfigured).toBe(false);
  });
});
