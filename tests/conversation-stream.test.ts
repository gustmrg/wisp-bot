import { describe, expect, it } from "vitest";

import {
  addPendingRequest,
  createConversationRuntime,
  overlayRuntimeMessages,
  pruneSettledRuntimeMessages,
  reconcileConversationRuntime,
  reduceConversationAgentEvent,
  removePendingRequest,
  stageOutgoingMessage,
  type StoredConversations,
} from "../src/lib/conversation-stream.js";
import type { ChatSummary, Message } from "../shared/conversations.js";

function chat(id: string): ChatSummary {
  return {
    id,
    name: id,
    label: "Test",
    description: "Test",
    kind: "wisp",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "Now",
  };
}

/** Conversations that exist, with the messages loaded for them (none unless given). */
function stored(ids: string[], windows: StoredConversations["windows"] = {}): StoredConversations {
  return { chats: Object.fromEntries(ids.map((id) => [id, chat(id)])), windows };
}

describe("conversation stream reducer", () => {
  it("reconciles queued and streaming messages by stable IDs and ignores event replay", () => {
    const chats = stored(["one", "two"]);
    let state = createConversationRuntime(0, { one: "idle", two: "idle" });
    state = stageOutgoingMessage(state, "one", {
      id: "request-1",
      type: "outgoing",
      text: "Inspect",
      status: "queued",
    });
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 1,
        type: "conversation_status",
        conversationId: "one",
        status: "working",
      },
      chats,
    );
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 2,
        type: "assistant_message_started",
        conversationId: "one",
        requestId: "request-1",
        messageId: "request-1:assistant",
        createdAt: "2026-08-31T23:10:00.000Z",
      },
      chats,
    );
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 3,
        type: "assistant_text_delta",
        conversationId: "one",
        requestId: "request-1",
        messageId: "request-1:assistant",
        delta: "First chunk",
      },
      chats,
    );
    const afterDelta = state;
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 3,
        type: "assistant_text_delta",
        conversationId: "one",
        requestId: "request-1",
        messageId: "request-1:assistant",
        delta: " duplicate",
      },
      chats,
    );

    expect(state).toBe(afterDelta);
    expect(overlayRuntimeMessages([], state.messages.one ?? [], true)).toEqual([
      expect.objectContaining({ id: "request-1", status: "complete" }),
      expect.objectContaining({
        id: "request-1:assistant",
        text: "First chunk",
        status: "streaming",
        createdAt: "2026-08-31T23:10:00.000Z",
      }),
    ]);
    expect(state.messages.two).toBeUndefined();
  });

  it("tracks sanitized activity, cancellation, and retryable errors without cross-chat leakage", () => {
    const chats = stored(["one", "two"]);
    let state = createConversationRuntime(0, {});
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 1,
        type: "tool_activity",
        conversationId: "one",
        requestId: "request-1",
        toolCallId: "read-1",
        toolName: "read",
        phase: "started",
      },
      chats,
    );
    expect(state.activity.one).toBe("Reading files…");
    expect(state.toolActivities.one).toContainEqual(
      expect.objectContaining({
        toolCallId: "read-1",
        phase: "started",
      }),
    );

    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 2,
        type: "assistant_message_cancelled",
        conversationId: "one",
        requestId: "request-1",
        messageId: "request-1:assistant",
      },
      chats,
    );
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 3,
        type: "conversation_error",
        conversationId: "two",
        requestId: "request-2",
        createdAt: "2026-08-31T23:11:00.000Z",
        error: { code: "internal_error", message: "Try again.", retryable: true },
      },
      chats,
    );
    expect(state.messages.one).toContainEqual(expect.objectContaining({ status: "cancelled", text: "" }));
    expect(state.messages.two).toContainEqual(
      expect.objectContaining({
        status: "failed",
        text: "Try again.",
        createdAt: "2026-08-31T23:11:00.000Z",
      }),
    );
    expect(state.errors.one).toBeUndefined();
    expect(state.errors.two?.retryable).toBe(true);
  });

  it("tracks approval requests until the matching resolution arrives", () => {
    const chats = stored(["one"]);
    let state = createConversationRuntime(0, {});
    state = reduceConversationAgentEvent(
      state,
      {
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
      },
      chats,
    );
    expect(state.approvals.one).toHaveLength(1);
    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 2,
        type: "tool_approval_resolved",
        conversationId: "one",
        approvalId: "approval-1",
        toolCallId: "write-1",
        decision: "allow_once",
      },
      chats,
    );
    expect(state.approvals.one).toEqual([]);
  });

  it("tracks concurrent acknowledgements by immutable request ID", () => {
    let pending = addPendingRequest({}, "one", "request-1");
    pending = addPendingRequest(pending, "one", "request-2");
    pending = addPendingRequest(pending, "two", "request-3");

    pending = removePendingRequest(pending, "one", "request-1");
    expect(pending).toEqual({ one: ["request-2"], two: ["request-3"] });
    expect(removePendingRequest(pending, "one", "unrelated")).toBe(pending);
  });

  it("advances past late events without resurrecting a deleted conversation", () => {
    const initial = createConversationRuntime(4, { deleted: "working", one: "idle" });
    const reconciled = reconcileConversationRuntime(initial, { one: chat("one") }, { one: "idle" });
    const afterLateEvent = reduceConversationAgentEvent(
      reconciled,
      {
        sequence: 5,
        type: "conversation_error",
        conversationId: "deleted",
        requestId: "request-1",
        createdAt: "2026-09-02T12:00:00.000Z",
        error: { code: "internal_error", message: "Late", retryable: false },
      },
      stored(["one"]),
    );

    expect(afterLateEvent.sequence).toBe(5);
    expect(afterLateEvent.statuses).not.toHaveProperty("deleted");
    expect(afterLateEvent.messages).not.toHaveProperty("deleted");
    expect(afterLateEvent.errors).not.toHaveProperty("deleted");
  });

  it("continues a reply from the messages the backend had live when the renderer started", () => {
    const live: Message = { id: "reply", type: "incoming", text: "So far", status: "streaming" };
    let state = createConversationRuntime(7, { one: "working" }, [], { one: [live] });

    state = reduceConversationAgentEvent(
      state,
      {
        sequence: 8,
        type: "assistant_text_delta",
        conversationId: "one",
        requestId: "r",
        messageId: "reply",
        delta: "!",
      },
      stored(["one"]),
    );

    expect(state.messages.one).toEqual([
      expect.objectContaining({ id: "reply", text: "So far!", status: "streaming" }),
    ]);
  });

  it("reads a message it does not hold from the loaded window", () => {
    const outgoing: Message = { id: "request-1", type: "outgoing", text: "Inspect", status: "queued" };
    const state = reduceConversationAgentEvent(
      createConversationRuntime(0, { one: "idle" }),
      {
        sequence: 1,
        type: "assistant_message_started",
        conversationId: "one",
        requestId: "request-1",
        messageId: "reply",
        createdAt: "2026-08-31T23:10:00.000Z",
      },
      stored(["one"], { one: { messages: [outgoing] } }),
    );

    expect(state.messages.one).toEqual([
      expect.objectContaining({ id: "request-1", text: "Inspect", status: "complete" }),
      expect.objectContaining({ id: "reply", status: "streaming" }),
    ]);
  });
});

describe("overlayRuntimeMessages", () => {
  const first: Message = { id: "a", type: "incoming", text: "Stored" };
  const newer: Message = { id: "a", type: "incoming", text: "Newer", status: "streaming" };
  const unstored: Message = { id: "b", type: "incoming", text: "Live", status: "streaming" };

  it("replaces stored copies everywhere but adds unstored messages only to an attached window", () => {
    expect(overlayRuntimeMessages([first], [newer, unstored], true)).toEqual([newer, unstored]);
    expect(overlayRuntimeMessages([first], [newer, unstored], false)).toEqual([newer]);
  });

  it("returns the same messages when nothing is in flight", () => {
    const messages = [first];
    expect(overlayRuntimeMessages(messages, [], true)).toBe(messages);
    expect(overlayRuntimeMessages(messages, [unstored], false)).toBe(messages);
  });
});

describe("pruneSettledRuntimeMessages", () => {
  const settled: Message = { id: "reply", type: "incoming", text: "Done", status: "complete" };
  const streaming: Message = { id: "next", type: "incoming", text: "Wor", status: "streaming" };

  it("drops a settled copy once the same settled message is stored, and keeps what is still in flight", () => {
    const state = createConversationRuntime(0, {}, [], { one: [settled, streaming], two: [settled] });

    const pruned = pruneSettledRuntimeMessages(state, "one", [settled, { ...streaming, text: "" }]);

    expect(pruned.messages).toEqual({ one: [streaming], two: [settled] });
  });

  it("keeps a copy whose stored version is in a different state", () => {
    const state = createConversationRuntime(0, {}, [], { one: [{ ...settled, status: "failed" }] });

    expect(pruneSettledRuntimeMessages(state, "one", [settled])).toBe(state);
    expect(pruneSettledRuntimeMessages(state, "one", [])).toBe(state);
  });
});
