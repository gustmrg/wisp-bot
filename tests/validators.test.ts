import { describe, expect, it } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import {
  parseSetJobMemoryRequest,
  parseAppendConversationMessageRequest,
  parseMessagePageRequest,
  parseSearchMessagesRequest,
  parseApplyModelRequest,
  parseApplyMemoryRequest,
  parseExportMemoryRequest,
  parseMemoryRequest,
  parseConversationRequest,
  parseCreateConversationRequest,
  parseCreateWispRequest,
  parseDeleteWispRequest,
  parseRemoveProviderCredentialRequest,
  parseResolveToolApprovalRequest,
  parseSaveAiSettingsRequest,
  parseSaveAuxiliaryModelRequest,
  parseSaveFallbackModelRequest,
  parseApplyFallbackModelRequest,
  parseSaveVoiceCredentialRequest,
  parseSendMessageRequest,
  parseSaveWispExecutionRequest,
  parseSetWorkspaceQuotaRequest,
  parseTranscribeAudioRequest,
  parseUpdateConversationRequest,
  parseUpdateWispRequest,
} from "../backend/validators.js";
import { MAX_VOICE_AUDIO_BYTES } from "../shared/voice.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

describe("memory request validators", () => {
  it("accepts each operation's shape and leaves the rest to the memory store", () => {
    const operations = [
      { op: "add", scope: "user", text: "Prefers short answers." },
      { op: "add", scope: "wisp", text: "Travelling.", expiresAt: "2026-10-30" },
      { op: "patch", id: "m1", text: "" },
      { op: "remove", id: "m2" },
      { op: "restore", id: "m3" },
    ];
    expect(parseApplyMemoryRequest({ conversationId: "wisp:one", operations })).toEqual({
      conversationId: "wisp:one",
      operations,
    });
    expect(parseExportMemoryRequest({ conversationId: "wisp:one", scope: "wisp" })).toEqual({
      conversationId: "wisp:one",
      scope: "wisp",
    });
  });

  it("rejects malformed memory requests", () => {
    for (const operations of [
      undefined,
      [{ op: "replace", scope: "user", text: "x" }],
      [{ op: "add", scope: "everyone", text: "x" }],
      [{ op: "add", scope: "user", text: 42 }],
      [{ op: "add", scope: "user", text: "x".repeat(4001) }],
      [{ op: "add", scope: "user", text: "x", source: "agent" }],
      [{ op: "remove", id: "m1", text: "x" }],
      [{ op: "patch", id: "", text: "x" }],
      Array.from({ length: 501 }, () => ({ op: "remove", id: "m1" })),
    ]) {
      expect(() => parseApplyMemoryRequest({ conversationId: "wisp:one", operations })).toThrow(WispBackendError);
    }
    expect(() => parseExportMemoryRequest({ conversationId: "wisp:one", scope: "all" })).toThrow(WispBackendError);
  });

  it("reads a request without a conversation as the person's own memory", () => {
    expect(parseMemoryRequest({})).toEqual({});
    expect(parseMemoryRequest({ conversationId: "wisp:one" })).toEqual({ conversationId: "wisp:one" });
    expect(parseApplyMemoryRequest({ operations: [] })).toEqual({ operations: [] });
    expect(parseExportMemoryRequest({ scope: "user" })).toEqual({ scope: "user" });
    for (const request of [undefined, { conversationId: "" }, { conversationId: null }]) {
      expect(() => parseMemoryRequest(request)).toThrow(WispBackendError);
    }
  });
});

describe("voice request validators", () => {
  const audio = new Uint8Array([1, 2, 3]);
  const valid = { providerId: "groq", modelId: "whisper-large-v3", language: "auto", mimeType: "audio/webm", audio };

  it("accepts a recording for a known provider, model, and language", () => {
    expect(parseTranscribeAudioRequest(valid)).toEqual(valid);
    expect(parseSaveVoiceCredentialRequest({ providerId: "openai", apiKey: "key" })).toEqual({
      providerId: "openai",
      apiKey: "key",
    });
  });

  it("rejects unknown providers, models from another provider, and non-binary audio", () => {
    for (const request of [
      { ...valid, providerId: "deepgram" },
      { ...valid, modelId: "gpt-4o-transcribe" },
      { ...valid, language: "xx" },
      { ...valid, mimeType: "video/webm" },
      { ...valid, audio: [1, 2, 3] },
    ]) {
      expect(() => parseTranscribeAudioRequest(request)).toThrow("The backend request is invalid.");
    }
    expect(() => parseSaveVoiceCredentialRequest({ providerId: "openrouter", apiKey: "key" })).toThrow();
  });

  it("accepts one fallback model, a known provider and one of its models", () => {
    const fallbacks = [{ providerId: "openai", modelId: "whisper-1" }];
    expect(parseTranscribeAudioRequest({ ...valid, fallbacks })).toEqual({ ...valid, fallbacks });
    // No fallback is the same as none given.
    expect(parseTranscribeAudioRequest({ ...valid, fallbacks: [] })).toEqual(valid);
    for (const bad of [
      [...fallbacks, { providerId: "mistral", modelId: "voxtral-mini-latest" }],
      [{ providerId: "openai", modelId: "voxtral-mini-latest" }],
      [{ providerId: "deepgram", modelId: "nova" }],
      [{ providerId: "openai", modelId: "whisper-1", apiKey: "key" }],
      "openai",
    ]) {
      expect(() => parseTranscribeAudioRequest({ ...valid, fallbacks: bad })).toThrow(
        "The backend request is invalid.",
      );
    }
  });

  it("explains empty and oversized recordings", () => {
    expect(() => parseTranscribeAudioRequest({ ...valid, audio: new Uint8Array() })).toThrow("The recording is empty.");
    expect(() => parseTranscribeAudioRequest({ ...valid, audio: new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1) })).toThrow(
      "too long",
    );
  });
});

describe("job request validators", () => {
  it("turns a job's memory on or off, and nothing else (SWE-248)", () => {
    expect(parseSetJobMemoryRequest({ jobId: "job-1", useMemory: true })).toEqual({ jobId: "job-1", useMemory: true });
    expect(() => parseSetJobMemoryRequest({ jobId: "job-1" })).toThrow(WispBackendError);
    expect(() => parseSetJobMemoryRequest({ jobId: "job-1", useMemory: "on" })).toThrow(WispBackendError);
    expect(() => parseSetJobMemoryRequest({ jobId: "", useMemory: true })).toThrow(WispBackendError);
  });
});

describe("IPC request validators", () => {
  it("accepts valid conversation and message requests", () => {
    expect(parseConversationRequest({ conversationId: "wisp:one" })).toEqual({
      conversationId: "wisp:one",
    });
    expect(
      parseSendMessageRequest({
        conversationId: "wisp:one",
        requestId: "request-1",
        text: "  keep intentional whitespace  ",
      }),
    ).toEqual({
      conversationId: "wisp:one",
      requestId: "request-1",
      text: "  keep intentional whitespace  ",
    });
  });

  it("validates command settings, keeping an omitted token distinct from a removed one", () => {
    expect(
      parseSaveWispExecutionRequest({
        conversationId: "wisp:one",
        mode: "container",
        image: null,
        localNetwork: false,
      }),
    ).toEqual({ conversationId: "wisp:one", mode: "container", image: null, localNetwork: false });
    expect(
      parseSaveWispExecutionRequest({
        conversationId: "wisp:one",
        mode: "off",
        image: "node:22",
        localNetwork: true,
        gitToken: "dropped",
      }),
    ).toEqual({ conversationId: "wisp:one", mode: "off", image: "node:22", localNetwork: true });
    for (const payload of [
      { conversationId: "wisp:one", mode: "local", image: null, localNetwork: false },
      { conversationId: "wisp:one", mode: "container", image: "--privileged", localNetwork: false },
      { conversationId: "wisp:one", mode: "container", image: "", localNetwork: false },
      { conversationId: "wisp:one", mode: "container", localNetwork: false },
      { conversationId: "wisp:one", mode: "container", image: null },
      { conversationId: "wisp:one", mode: "container", image: null, localNetwork: "yes" },
    ]) {
      expect(() => parseSaveWispExecutionRequest(payload)).toThrow(WispBackendError);
    }
  });

  it("accepts only the offered workspace sizes, or none", () => {
    const gib = 1024 * 1024 * 1024;
    expect(parseSetWorkspaceQuotaRequest({ conversationId: "wisp:one", quotaBytes: 2 * gib })).toEqual({
      conversationId: "wisp:one",
      quotaBytes: 2 * gib,
    });
    expect(parseSetWorkspaceQuotaRequest({ conversationId: "wisp:one", quotaBytes: gib })).toMatchObject({
      quotaBytes: gib,
    });
    expect(parseSetWorkspaceQuotaRequest({ conversationId: "wisp:one", quotaBytes: null })).toEqual({
      conversationId: "wisp:one",
      quotaBytes: null,
    });
    for (const quotaBytes of [0, -1, 3 * gib, 2 * gib + 0.5, "2147483648", undefined, "unlimited", Infinity]) {
      expect(() => parseSetWorkspaceQuotaRequest({ conversationId: "wisp:one", quotaBytes })).toThrow(WispBackendError);
    }
    expect(() => parseSetWorkspaceQuotaRequest({ conversationId: "../escape", quotaBytes: 2 * gib })).toThrow(
      WispBackendError,
    );
  });

  it.each([null, {}, { conversationId: "" }, { conversationId: "../escape" }, { conversationId: "a".repeat(129) }])(
    "rejects invalid conversation payload %#",
    (payload) => {
      expect(() => parseConversationRequest(payload)).toThrow(WispBackendError);
    },
  );

  it.each([
    { conversationId: "wisp-1", requestId: "request-1", text: "" },
    { conversationId: "wisp-1", requestId: "request-1", text: "   " },
    { conversationId: "wisp-1", requestId: "bad id", text: "Hello" },
    { conversationId: "wisp-1", requestId: "request-1", text: "x".repeat(32_001) },
  ])("rejects invalid message payload %#", (payload) => {
    expect(() => parseSendMessageRequest(payload)).toThrow(WispBackendError);
  });

  it("lets the renderer save only messages the user wrote", () => {
    expect(
      parseAppendConversationMessageRequest({
        conversationId: "wisp-1",
        message: { id: "request-1", type: "outgoing", text: "Hello", status: "queued" },
      }),
    ).toMatchObject({ message: { type: "outgoing", text: "Hello" } });
  });

  it.each([
    { id: "request-1:assistant", type: "incoming", text: "Forged reply" },
    { type: "time", text: "Context summarized" },
    { type: "card", items: [] },
    { type: "prompt", question: "Proceed?", options: [] },
  ])("rejects renderer writes of backend-owned messages: $type", (message) => {
    expect(() => parseAppendConversationMessageRequest({ conversationId: "wisp-1", message })).toThrow(
      WispBackendError,
    );
  });

  it("accepts each transcript page shape", () => {
    expect(parseMessagePageRequest({ conversationId: "wisp-1", page: "latest" })).toEqual({
      conversationId: "wisp-1",
      page: "latest",
    });
    expect(parseMessagePageRequest({ conversationId: "wisp-1", page: "older", cursor: "42" })).toEqual({
      conversationId: "wisp-1",
      page: "older",
      cursor: "42",
    });
    expect(
      parseMessagePageRequest({ conversationId: "wisp-1", page: "around", messageId: "request-1:assistant" }),
    ).toMatchObject({ page: "around", messageId: "request-1:assistant" });
  });

  it.each([
    { conversationId: "wisp-1", page: "sideways" },
    { conversationId: "wisp-1", page: "older" },
    { conversationId: "wisp-1", page: "newer", cursor: "-1" },
    { conversationId: "wisp-1", page: "newer", cursor: "1e3" },
    { conversationId: "wisp-1", page: "older", cursor: "1".repeat(16) },
    { conversationId: "wisp-1", page: "latest", cursor: "1" },
    { conversationId: "wisp-1", page: "around", messageId: "../x" },
  ])("rejects malformed page request %#", (payload) => {
    expect(() => parseMessagePageRequest(payload)).toThrow(WispBackendError);
  });

  it("requires 3 characters for message search and trims the query", () => {
    expect(parseSearchMessagesRequest({ query: "  orç  " })).toEqual({ query: "orç" });
    expect(() => parseSearchMessagesRequest({ query: " ab " })).toThrow("Message search needs at least 3 characters.");
    expect(() => parseSearchMessagesRequest({ query: "x".repeat(201) })).toThrow(WispBackendError);
    expect(() => parseSearchMessagesRequest({ query: 42 })).toThrow(WispBackendError);
  });

  it("validates both provider and model identifiers", () => {
    expect(
      parseApplyModelRequest({
        conversationId: "wisp-1",
        model: { providerId: "anthropic", modelId: "claude.example-1" },
      }),
    ).toEqual({
      conversationId: "wisp-1",
      model: { providerId: "anthropic", modelId: "claude.example-1" },
    });

    expect(() =>
      parseApplyModelRequest({
        conversationId: "wisp-1",
        model: { providerId: "anthropic", modelId: "bad model" },
      }),
    ).toThrow(WispBackendError);
  });

  it("accepts known thinking levels, drops the default, and rejects others", () => {
    const request = (thinkingLevel: unknown) => ({
      conversationId: "wisp-1",
      model: { providerId: "anthropic", modelId: "claude", thinkingLevel },
    });
    expect(parseApplyModelRequest(request("xhigh")).model).toEqual({
      providerId: "anthropic",
      modelId: "claude",
      thinkingLevel: "xhigh",
    });
    expect(parseApplyModelRequest(request("off")).model).toEqual({ providerId: "anthropic", modelId: "claude" });
    expect(() => parseApplyModelRequest(request("extreme"))).toThrow(WispBackendError);
    expect(() => parseApplyModelRequest(request(3))).toThrow(WispBackendError);
    expect(
      parseSaveAuxiliaryModelRequest({
        task: "imageUnderstanding",
        selection: { providerId: "openai", modelId: "vision", thinkingLevel: "high" },
      }),
    ).toEqual({ task: "imageUnderstanding", selection: { providerId: "openai", modelId: "vision" } });
  });

  it("accepts catalog model IDs containing slashes", () => {
    expect(
      parseSaveAiSettingsRequest({
        selection: { providerId: "openrouter", modelId: "anthropic/claude-example" },
        apiKey: "secret-key",
      }),
    ).toEqual({
      selection: { providerId: "openrouter", modelId: "anthropic/claude-example" },
      apiKey: "secret-key",
    });
    expect(parseRemoveProviderCredentialRequest({ providerId: "openrouter" })).toEqual({
      providerId: "openrouter",
    });
    expect(
      parseSaveAiSettingsRequest({
        selection: { providerId: "openrouter", modelId: "anthropic/claude-example", maxOutputTokens: 16_384 },
      }),
    ).toEqual({
      selection: { providerId: "openrouter", modelId: "anthropic/claude-example", maxOutputTokens: 16_384 },
    });
    expect(() =>
      parseSaveAiSettingsRequest({
        selection: { providerId: "openrouter", modelId: "anthropic/claude-example", maxOutputTokens: 0 },
      }),
    ).toThrow(WispBackendError);
  });

  it("accepts an auxiliary model or off for a known task, without an output limit", () => {
    expect(
      parseSaveAuxiliaryModelRequest({
        task: "imageUnderstanding",
        selection: { providerId: "openrouter", modelId: "openai/vision", maxOutputTokens: 100 },
      }),
    ).toEqual({ task: "imageUnderstanding", selection: { providerId: "openrouter", modelId: "openai/vision" } });
    expect(parseSaveAuxiliaryModelRequest({ task: "imageUnderstanding", selection: null })).toEqual({
      task: "imageUnderstanding",
      selection: null,
    });
    expect(() => parseSaveAuxiliaryModelRequest({ task: "titles", selection: null })).toThrow(WispBackendError);
    expect(() =>
      parseSaveAuxiliaryModelRequest({ task: "imageUnderstanding", selection: { providerId: "openrouter" } }),
    ).toThrow(WispBackendError);
  });

  it("accepts a fallback model without an output limit or reasoning, or off", () => {
    const backup = { providerId: "openrouter", modelId: "openai/gpt-oss-120b" };
    expect(
      parseSaveFallbackModelRequest({ selection: { ...backup, maxOutputTokens: 100, thinkingLevel: "high" } }),
    ).toEqual({
      selection: backup,
    });
    expect(parseSaveFallbackModelRequest({ selection: null })).toEqual({ selection: null });
    expect(() => parseSaveFallbackModelRequest({ selection: { providerId: "openrouter" } })).toThrow(WispBackendError);

    expect(parseApplyFallbackModelRequest({ conversationId: "wisp-1", fallback: "off" })).toEqual({
      conversationId: "wisp-1",
      fallback: "off",
    });
    expect(parseApplyFallbackModelRequest({ conversationId: "wisp-1", fallback: "global" }).fallback).toBe("global");
    expect(
      parseApplyFallbackModelRequest({ conversationId: "wisp-1", fallback: { ...backup, maxOutputTokens: 9 } }),
    ).toEqual({
      conversationId: "wisp-1",
      fallback: backup,
    });
    expect(() => parseApplyFallbackModelRequest({ conversationId: "wisp-1", fallback: "inherit" })).toThrow(
      WispBackendError,
    );
    expect(() => parseApplyFallbackModelRequest({ conversationId: "wisp-1", fallback: null })).toThrow(
      WispBackendError,
    );
  });

  it("binds tool approval decisions to stable identifiers", () => {
    expect(
      parseResolveToolApprovalRequest({
        approvalId: "approval-1",
        conversationId: "wisp-1",
        toolCallId: "tool-1",
        decision: "allow_once",
      }),
    ).toEqual({
      approvalId: "approval-1",
      conversationId: "wisp-1",
      toolCallId: "tool-1",
      decision: "allow_once",
    });
    expect(() =>
      parseResolveToolApprovalRequest({
        approvalId: "approval-1",
        conversationId: "wisp-1",
        toolCallId: "tool-1",
        decision: "allow_forever",
      }),
    ).toThrow(WispBackendError);
    expect(
      parseResolveToolApprovalRequest({
        approvalId: "approval-1",
        conversationId: "wisp-1",
        toolCallId: "tool-1",
        decision: "allow_always",
      }).decision,
    ).toBe("allow_always");
  });

  it("rejects fields from the other conversation variant", () => {
    expect(() =>
      parseUpdateConversationRequest({
        conversationId: "wisp-1",
        changes: { kind: "wisp", memberIds: [] },
      }),
    ).toThrow(WispBackendError);
    expect(() =>
      parseUpdateConversationRequest({
        conversationId: "circle-1",
        changes: { kind: "circle", shape: "circle" },
      }),
    ).toThrow(WispBackendError);
  });

  it("rejects Wisp fields on a Wisp's conversation, which only carries notifications and read state", () => {
    expect(
      parseUpdateConversationRequest({ conversationId: "wisp-1", changes: { kind: "wisp", unread: false } }).changes,
    ).toEqual({ kind: "wisp", unread: false });
    expect(
      parseUpdateConversationRequest({ conversationId: "wisp-1", changes: { kind: "wisp", pinned: true } }).changes,
    ).toEqual({ kind: "wisp", pinned: true });
    expect(() =>
      parseUpdateConversationRequest({ conversationId: "wisp-1", changes: { kind: "wisp", pinned: "yes" } }),
    ).toThrow(WispBackendError);
    for (const field of ["name", "soul", "shape", "tone"]) {
      expect(() =>
        parseUpdateConversationRequest({ conversationId: "wisp-1", changes: { kind: "wisp", [field]: "x" } }),
      ).toThrow(WispBackendError);
    }
  });

  it("creates only circles as conversations", () => {
    const circle = {
      id: "crew",
      kind: "circle",
      name: "Crew",
      label: "",
      description: "",
      memberIds: [],
      notifyOnUpdatesEnabled: true,
      preview: "Ready",
      messages: [],
    };
    expect(parseCreateConversationRequest({ conversation: circle }).conversation).toMatchObject({ id: "crew" });
    expect(() =>
      parseCreateConversationRequest({
        conversation: {
          id: "atlas",
          kind: "wisp",
          wispId: "atlas",
          notifyOnUpdatesEnabled: true,
          preview: "",
          messages: [],
        },
      }),
    ).toThrow(WispBackendError);
  });

  it("keeps a stored Wisp whose appearance has values this build does not know", () => {
    const request = parseCreateWispRequest({
      wisp: {
        id: "newer",
        name: "Newer",
        role: "",
        soul: "",
        appearance: { ...DEFAULT_WISP_APPEARANCE, trail: "twin", eyes: "stars", sparkle: true },
        color: "#3c82f7",
      },
      notifyOnUpdatesEnabled: true,
    });

    expect(request.wisp.appearance).toEqual(DEFAULT_WISP_APPEARANCE);
    // A color outside the palette moves to the closest palette color.
    expect(request.wisp.color).toBe("#3c82f6");
  });

  it("accepts only complete appearances and palette colors as changes", () => {
    const appearance = { ...DEFAULT_WISP_APPEARANCE, trail: "curl", finish: "line" };
    expect(parseUpdateWispRequest({ wispId: "wisp-1", changes: { appearance, color: "#E5498F" } }).changes).toEqual({
      appearance,
      color: "#e5498f",
    });
    for (const changes of [
      { appearance: { trail: "curl" } },
      { appearance: { ...appearance, trail: "twin" } },
      { appearance: { ...appearance, extra: "x" } },
      { color: "#123456" },
      { shape: "circle" },
    ]) {
      expect(() => parseUpdateWispRequest({ wispId: "wisp-1", changes })).toThrow(WispBackendError);
    }
  });

  it("parses a Wisp's soul and changes, and rejects tone and unknown fields", () => {
    const wisp = {
      id: "wisp-1",
      name: "Atlas",
      role: "Research",
      soul: "# Identity\nCareful",
      appearance: DEFAULT_WISP_APPEARANCE,
    };
    expect(parseCreateWispRequest({ wisp, notifyOnUpdatesEnabled: false })).toEqual({
      wisp,
      notifyOnUpdatesEnabled: false,
      model: null,
    });
    expect(() => parseCreateWispRequest({ wisp })).toThrow(WispBackendError);
    expect(() => parseCreateWispRequest({ wisp: { ...wisp, name: " " }, notifyOnUpdatesEnabled: true })).toThrow(
      WispBackendError,
    );
    expect(parseUpdateWispRequest({ wispId: "wisp-1", changes: { soul: "Direct", color: undefined } })).toEqual({
      wispId: "wisp-1",
      changes: { soul: "Direct", color: undefined },
    });
    for (const changes of [{ tone: { style: "direct", length: "short", custom: "" } }, { description: "x" }]) {
      expect(() => parseUpdateWispRequest({ wispId: "wisp-1", changes })).toThrow(WispBackendError);
    }
    expect(() =>
      parseUpdateWispRequest({ wispId: "wisp-1", changes: { avatarImage: "data:image/png;base64,AAAA" } }),
    ).toThrow(WispBackendError);
    expect(parseDeleteWispRequest({ wispId: "wisp-1" })).toEqual({ wispId: "wisp-1" });
  });

  it("parses a creation-time model selection and rejects invalid ones", () => {
    const wisp = { id: "wisp-1", name: "Atlas", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE };

    expect(
      parseCreateWispRequest({
        wisp,
        notifyOnUpdatesEnabled: true,
        model: { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 },
      }).model,
    ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 });
    expect(parseCreateWispRequest({ wisp, notifyOnUpdatesEnabled: true, model: null }).model).toBeNull();
    expect(() =>
      parseCreateWispRequest({
        wisp,
        notifyOnUpdatesEnabled: true,
        model: { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 0 },
      }),
    ).toThrow(WispBackendError);
    expect(() =>
      parseCreateWispRequest({ wisp, notifyOnUpdatesEnabled: true, model: { providerId: "anthropic" } }),
    ).toThrow(WispBackendError);
  });
});
