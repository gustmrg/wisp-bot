import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConversations } from "@/hooks/use-conversations";
import type { ConversationAgentEvent, SequencedConversationAgentEvent, WispApi } from "../../shared/contracts";
import type { Chat, ConversationStateView, Message } from "../../shared/conversations";

const atlas: Chat = {
  id: "atlas",
  name: "Atlas",
  label: "Research",
  description: "",
  kind: "wisp",
  shape: "circle",
  notifyOnUpdatesEnabled: true,
  preview: "Ready",
  timestamp: "2026-09-29T12:00:00.000Z",
  messages: [],
};

function installBridge() {
  let state: ConversationStateView = {
    initialized: true,
    chats: { atlas },
    statuses: { atlas: "idle" },
    agentEventSequence: 0,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
  };
  const agentListeners = new Set<(event: SequencedConversationAgentEvent) => void>();
  const chatListeners = new Set<(chat: Chat) => void>();
  const api = {
    getConversationState: vi.fn(async () => ({ ok: true as const, value: state })),
    initializeConversations: vi.fn(),
    appendConversationMessage: vi.fn(
      async ({ conversationId, message }: { conversationId: string; message: Message }) => {
        const chat = state.chats[conversationId]!;
        const updated = { ...chat, messages: [...chat.messages, message] };
        state = { ...state, chats: { ...state.chats, [conversationId]: updated } };
        return { ok: true as const, value: updated };
      },
    ),
    sendMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    subscribeToAgentEvents: vi.fn((listener: (event: SequencedConversationAgentEvent) => void) => {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    }),
    subscribeToConversationChanges: vi.fn((listener: (chat: Chat) => void) => {
      chatListeners.add(listener);
      return () => chatListeners.delete(listener);
    }),
  };
  (window as unknown as { wisp: WispApi }).wisp = api as unknown as WispApi;
  let sequence = 0;
  return {
    api,
    emit(event: ConversationAgentEvent) {
      sequence += 1;
      act(() => {
        for (const listener of agentListeners) listener({ ...event, sequence });
      });
    },
    push(chat: Chat) {
      act(() => {
        for (const listener of chatListeners) listener(chat);
      });
    },
  };
}

async function startTurn(bridge: ReturnType<typeof installBridge>) {
  const hook = renderHook(() => useConversations());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await hook.result.current.sendMessage("atlas", "Hello");
  });
  const outgoing = bridge.api.appendConversationMessage.mock.calls[0]![0].message as Message & { id: string };
  const requestId = outgoing.id;
  bridge.emit({
    type: "assistant_message_started",
    conversationId: "atlas",
    requestId,
    messageId: "reply",
    createdAt: "2026-09-29T12:00:01.000Z",
  });
  bridge.emit({ type: "assistant_text_delta", conversationId: "atlas", requestId, messageId: "reply", delta: "Hi" });
  return { hook, outgoing, requestId };
}

describe("useConversations", () => {
  it("leaves agent-driven persistence to the backend instead of writing or re-fetching", async () => {
    const bridge = installBridge();
    const { hook, requestId } = await startTurn(bridge);
    bridge.emit({
      type: "assistant_text_delta",
      conversationId: "atlas",
      requestId,
      messageId: "reply",
      delta: " there",
    });
    bridge.emit({ type: "assistant_message_completed", conversationId: "atlas", requestId, messageId: "reply" });

    // Only the user's own message is written; reply text and delivery status belong to the backend.
    expect(bridge.api.appendConversationMessage).toHaveBeenCalledTimes(1);
    expect(bridge.api.getConversationState).toHaveBeenCalledTimes(1);
    expect(hook.result.current.chats.atlas?.messages).toEqual([
      expect.objectContaining({ id: requestId, type: "outgoing", status: "complete" }),
      expect.objectContaining({ id: "reply", type: "incoming", text: "Hi there", status: "complete" }),
    ]);
  });

  it("applies a pushed chat and drops transient copies the backend has settled", async () => {
    const bridge = installBridge();
    const { hook, outgoing, requestId } = await startTurn(bridge);
    bridge.emit({ type: "assistant_message_completed", conversationId: "atlas", requestId, messageId: "reply" });
    const stored: Chat = {
      ...atlas,
      preview: "Hi",
      messages: [
        { ...outgoing, status: "complete" },
        { id: "reply", type: "incoming", text: "Hi", status: "complete", createdAt: "2026-09-29T12:00:01.000Z" },
      ],
    };

    bridge.push(stored);

    expect(hook.result.current.chats.atlas).toBe(stored);
  });

  it("keeps the newer streaming copy over a pushed snapshot taken mid-reply", async () => {
    const bridge = installBridge();
    const { hook, outgoing, requestId } = await startTurn(bridge);
    const snapshot: Chat = {
      ...atlas,
      messages: [
        { ...outgoing, status: "complete" },
        { id: "reply", type: "incoming", text: "", status: "streaming" },
      ],
    };

    bridge.push(snapshot);
    bridge.emit({ type: "assistant_text_delta", conversationId: "atlas", requestId, messageId: "reply", delta: "!" });

    expect(hook.result.current.chats.atlas?.messages.at(-1)).toEqual(
      expect.objectContaining({ id: "reply", text: "Hi!", status: "streaming" }),
    );
  });
});
