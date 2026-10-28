import { describe, expect, it, vi } from "vitest";

import { TranscriptionService } from "../backend/transcription-service.js";
import type { TranscribeAudioRequest, VoiceCredentialSource } from "../shared/voice.js";

function createService(
  options: {
    keys?: Record<string, string>;
    voiceOnly?: ReadonlyArray<string>;
    response?: Response | Error;
    /** Responses by the provider's host, such as `api.groq.com`, for a chain of providers. */
    responses?: Record<string, Response | Error>;
  } = {},
) {
  const keys = new Map(Object.entries(options.keys ?? { groq: "groq-key" }));
  const source = (providerId: string): VoiceCredentialSource =>
    options.voiceOnly?.includes(providerId) ? "voice" : "shared";
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const response =
      options.responses?.[new URL(String(url)).host] ?? options.response ?? Response.json({ text: "  Hello there.  " });
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
  const logger = { warn: vi.fn() };
  const service = new TranscriptionService({ credentials, fetch: fetch as unknown as typeof globalThis.fetch, logger });
  return { service, fetch, credentials, logger };
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

    await expect(service.transcribe(request)).resolves.toEqual({
      text: "Hello there.",
      providerId: "groq",
      modelId: "whisper-large-v3-turbo",
    });

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

  describe("with backup providers", () => {
    const withBackups: TranscribeAudioRequest = {
      ...request,
      fallbacks: [
        { providerId: "openai", modelId: "gpt-4o-mini-transcribe" },
        { providerId: "mistral", modelId: "voxtral-mini-latest" },
      ],
    };
    const keys = { groq: "groq-key", openai: "openai-key", mistral: "mistral-key" };
    const hosts = (fetch: ReturnType<typeof createService>["fetch"]) =>
      fetch.mock.calls.map(([url]) => new URL(String(url)).host);

    it.each([
      ["is rate limited", new Response("{}", { status: 429 })],
      ["is down", new Response("{}", { status: 503 })],
      ["cannot be reached", new TypeError("offline")],
      ["rejects its key", new Response("{}", { status: 401 })],
      ["has no credit left", new Response("{}", { status: 402 })],
    ])("goes to the next provider when one %s, and says which one answered", async (_reason, failure) => {
      const { service, fetch, logger } = createService({
        keys,
        responses: { "api.groq.com": failure, "api.openai.com": Response.json({ text: "From the backup." }) },
      });

      await expect(service.transcribe(withBackups)).resolves.toEqual({
        text: "From the backup.",
        providerId: "openai",
        modelId: "gpt-4o-mini-transcribe",
      });
      expect(hosts(fetch)).toEqual(["api.groq.com", "api.openai.com"]);
      expect((fetch.mock.calls[1]![1]?.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
      expect(logger.warn).toHaveBeenCalledWith(
        "transcription_fallback",
        expect.objectContaining({ providerId: "groq", nextProviderId: "openai" }),
      );
    });

    it("skips a provider without a key without calling it", async () => {
      const { service, fetch } = createService({ keys: { mistral: "mistral-key" } });

      await expect(service.transcribe(withBackups)).resolves.toMatchObject({ providerId: "mistral" });
      expect(hosts(fetch)).toEqual(["api.mistral.ai"]);
    });

    it.each([
      ["unreadable", 400],
      ["too long", 413],
      ["refused as content", 422],
    ])("stops at a recording the provider found %s, since every provider would", async (_reason, status) => {
      const { service, fetch } = createService({ keys, responses: { "api.groq.com": new Response("{}", { status }) } });

      await expect(service.transcribe(withBackups)).rejects.toMatchObject({ retryable: false });
      expect(hosts(fetch)).toEqual(["api.groq.com"]);
    });

    it("never sends the recording twice to the same provider and model", async () => {
      const { service, fetch } = createService({ keys, response: new Response("{}", { status: 500 }) });

      await expect(
        service.transcribe({ ...request, fallbacks: [{ providerId: "groq", modelId: "whisper-large-v3-turbo" }] }),
      ).rejects.toMatchObject({ code: "model_unavailable" });
      expect(hosts(fetch)).toEqual(["api.groq.com"]);
    });

    it("says every provider failed, and that trying again may work", async () => {
      const { service, fetch } = createService({ keys, response: new Response("{}", { status: 503 }) });

      await expect(service.transcribe(withBackups)).rejects.toMatchObject({
        code: "model_unavailable",
        retryable: true,
        message: "None of your voice providers could transcribe the recording (Groq, OpenAI, Mistral). Try again.",
      });
      expect(hosts(fetch)).toEqual(["api.groq.com", "api.openai.com", "api.mistral.ai"]);
    });

    it("points to Settings when every provider lacks a usable key", async () => {
      const { service } = createService({ keys: {} });

      await expect(service.transcribe(withBackups)).rejects.toMatchObject({
        code: "configuration_required",
        message: "Add a Groq API key in Settings to use voice input.",
      });
    });
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
