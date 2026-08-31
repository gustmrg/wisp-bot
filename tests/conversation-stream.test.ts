import { describe, expect, it } from "vitest";

import {
  createConversationRuntime,
  overlayRuntimeMessages,
  reduceConversationAgentEvent,
  stageOutgoingMessage,
} from "../src/lib/conversation-stream.js";
import type { Chat, ChatCollection } from "../shared/conversations.js";

function chat(id: string): Chat {
  return {
    id,
    name: id,
    label: "Test",
    description: "Test",
    shape: "circle",
    isCircle: false,
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
}

describe("conversation stream reducer", () => {
  it("reconciles queued and streaming messages by stable IDs and ignores event replay", () => {
    const chats: ChatCollection = { one: chat("one"), two: chat("two") };
    let state = createConversationRuntime(0, { one: "idle", two: "idle" });
    state = stageOutgoingMessage(state, "one", {
      id: "request-1",
      type: "outgoing",
      text: "Inspect",
      status: "queued",
    });
    state = reduceConversationAgentEvent(state, {
      sequence: 1,
      type: "conversation_status",
      conversationId: "one",
      status: "working",
    }, chats);
    state = reduceConversationAgentEvent(state, {
      sequence: 2,
      type: "assistant_message_started",
      conversationId: "one",
      requestId: "request-1",
      messageId: "request-1:assistant",
    }, chats);
    state = reduceConversationAgentEvent(state, {
      sequence: 3,
      type: "assistant_text_delta",
      conversationId: "one",
      requestId: "request-1",
      messageId: "request-1:assistant",
      delta: "First chunk",
    }, chats);
    const afterDelta = state;
    state = reduceConversationAgentEvent(state, {
      sequence: 3,
      type: "assistant_text_delta",
      conversationId: "one",
      requestId: "request-1",
      messageId: "request-1:assistant",
      delta: " duplicate",
    }, chats);

    expect(state).toBe(afterDelta);
    const visible = overlayRuntimeMessages(chats, state.messages);
    expect(visible.one.messages).toEqual([
      expect.objectContaining({ id: "request-1", status: "complete" }),
      expect.objectContaining({ id: "request-1:assistant", text: "First chunk", status: "streaming" }),
    ]);
    expect(visible.two.messages).toEqual([]);
  });

  it("tracks sanitized activity, cancellation, and retryable errors without cross-chat leakage", () => {
    const chats: ChatCollection = { one: chat("one"), two: chat("two") };
    let state = createConversationRuntime(0, {});
    state = reduceConversationAgentEvent(state, {
      sequence: 1,
      type: "tool_activity",
      conversationId: "one",
      requestId: "request-1",
      toolCallId: "read-1",
      toolName: "read",
      phase: "started",
    }, chats);
    expect(state.activity.one).toBe("Reading files…");
    expect(state.toolActivities.one).toContainEqual(expect.objectContaining({
      toolCallId: "read-1",
      phase: "started",
    }));

    state = reduceConversationAgentEvent(state, {
      sequence: 2,
      type: "assistant_message_cancelled",
      conversationId: "one",
      requestId: "request-1",
      messageId: "request-1:assistant",
    }, chats);
    state = reduceConversationAgentEvent(state, {
      sequence: 3,
      type: "conversation_error",
      conversationId: "two",
      requestId: "request-2",
      error: { code: "internal_error", message: "Try again.", retryable: true },
    }, chats);
    const visible = overlayRuntimeMessages(chats, state.messages);
    expect(visible.one.messages).toContainEqual(expect.objectContaining({ status: "cancelled", text: "Stopped." }));
    expect(visible.two.messages).toContainEqual(expect.objectContaining({ status: "failed", text: "Try again." }));
    expect(state.errors.one).toBeUndefined();
    expect(state.errors.two?.retryable).toBe(true);
  });

  it("tracks approval requests until the matching resolution arrives", () => {
    const chats: ChatCollection = { one: chat("one") };
    let state = createConversationRuntime(0, {});
    state = reduceConversationAgentEvent(state, {
      sequence: 1,
      type: "tool_approval_requested",
      conversationId: "one",
      request: {
        approvalId: "approval-1",
        conversationId: "one",
        toolCallId: "write-1",
        toolName: "write",
        category: "create_file",
        summary: "Create notes.txt",
        expiresAt: "2026-08-31T12:01:00.000Z",
      },
    }, chats);
    expect(state.approvals.one).toHaveLength(1);
    state = reduceConversationAgentEvent(state, {
      sequence: 2,
      type: "tool_approval_resolved",
      conversationId: "one",
      approvalId: "approval-1",
      toolCallId: "write-1",
      decision: "allow_once",
    }, chats);
    expect(state.approvals.one).toEqual([]);
  });
});
