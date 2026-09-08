import { describe, expect, it } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import {
  parseApplyModelRequest,
  parseConversationRequest,
  parseCreateConversationRequest,
  parseRemoveProviderCredentialRequest,
  parseResolveToolApprovalRequest,
  parseSaveAiSettingsRequest,
  parseSendMessageRequest,
  parseUpdateConversationRequest,
} from "../shared/validators.js";

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
  });
});
