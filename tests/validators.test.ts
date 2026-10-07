import { describe, expect, it } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import {
  parseAppendConversationMessageRequest,
  parseMessagePageRequest,
  parseSearchMessagesRequest,
  parseApplyModelRequest,
  parseConversationRequest,
  parseCreateConversationRequest,
  parseCreateWispRequest,
  parseDeleteWispRequest,
  parseRemoveProviderCredentialRequest,
  parseResolveToolApprovalRequest,
  parseSaveAiSettingsRequest,
  parseSaveVoiceCredentialRequest,
  parseSendMessageRequest,
  parseTranscribeAudioRequest,
  parseUpdateConversationRequest,
  parseUpdateWispRequest,
} from "../backend/validators.js";
import { MAX_VOICE_AUDIO_BYTES } from "../shared/voice.js";

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

  it("explains empty and oversized recordings", () => {
    expect(() => parseTranscribeAudioRequest({ ...valid, audio: new Uint8Array() })).toThrow("The recording is empty.");
    expect(() => parseTranscribeAudioRequest({ ...valid, audio: new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1) })).toThrow(
      "too long",
    );
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

  it("migrates the removed legacy pill shape without dropping the Wisp", () => {
    const request = parseCreateWispRequest({
      wisp: { id: "legacy-pill", name: "Legacy", role: "", soul: "", shape: "pill" },
      notifyOnUpdatesEnabled: true,
    });

    expect(request.wisp).toEqual({ id: "legacy-pill", name: "Legacy", role: "", soul: "", shape: "pebble" });
    expect(request.model).toBeNull();
  });

  it("parses a Wisp's soul and changes, and rejects tone and unknown fields", () => {
    const wisp = { id: "wisp-1", name: "Atlas", role: "Research", soul: "# Identity\nCareful", shape: "hexagon" };
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
    const wisp = { id: "wisp-1", name: "Atlas", role: "", soul: "", shape: "hexagon" };

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
