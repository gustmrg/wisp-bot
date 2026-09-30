import { describe, expect, it } from "vitest";

import { WispBackendError } from "../electron/backend/backend-error.js";
import {
  parseAppendConversationMessageRequest,
  parseApplyModelRequest,
  parseConversationRequest,
  parseCreateConversationRequest,
  parseRemoveProviderCredentialRequest,
  parseResolveToolApprovalRequest,
  parseSaveAiSettingsRequest,
  parseSendMessageRequest,
  parseUpdateConversationRequest,
} from "../electron/ipc/validators.js";

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

  it("migrates the removed legacy pill shape without dropping the Wisp", () => {
    const request = parseCreateConversationRequest({
      conversation: {
        id: "legacy-pill",
        kind: "wisp",
        name: "Legacy",
        label: "",
        description: "",
        shape: "pill",
        notifyOnUpdatesEnabled: true,
        preview: "Ready",
        timestamp: "Now",
        messages: [],
      },
    });

    expect(request.conversation).toEqual(expect.objectContaining({ id: "legacy-pill", shape: "pebble" }));
    expect(request.model).toBeNull();
  });

  it("parses a creation-time model selection and rejects invalid ones", () => {
    const conversation = {
      id: "wisp-1",
      kind: "wisp",
      name: "Atlas",
      label: "",
      description: "",
      shape: "hexagon",
      notifyOnUpdatesEnabled: true,
      preview: "Ready",
      timestamp: "Now",
      messages: [],
    };

    expect(
      parseCreateConversationRequest({
        conversation,
        model: { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 },
      }).model,
    ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 2048 });
    expect(parseCreateConversationRequest({ conversation, model: null }).model).toBeNull();
    expect(() =>
      parseCreateConversationRequest({
        conversation,
        model: { providerId: "anthropic", modelId: "claude-sonnet-4-5", maxOutputTokens: 0 },
      }),
    ).toThrow(WispBackendError);
    expect(() =>
      parseCreateConversationRequest({
        conversation,
        model: { providerId: "anthropic" },
      }),
    ).toThrow(WispBackendError);
  });
});
