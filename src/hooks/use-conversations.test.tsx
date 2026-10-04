import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useConversations } from "@/hooks/use-conversations";
import type {
  BackendResult,
  ConversationAgentEvent,
  SequencedConversationAgentEvent,
  WispApi,
} from "../../shared/contracts";
import type {
  ChatSummary,
  ConversationDelta,
  ConversationStateView,
  Message,
  MessagePage,
  MessagePageRequest,
} from "../../shared/conversations";

const PAGE_SIZE = 2;

function wisp(id: string): ChatSummary {
  return {
    id,
    name: id,
    label: "Research",
    description: "",
    kind: "wisp",
    shape: "circle",
    notifyOnUpdatesEnabled: true,
    preview: "Ready",
    timestamp: "2026-09-29T12:00:00.000Z",
  };
}

function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}`, type: "incoming", text: `Message ${index}` }));
}

/** Pages of a stored transcript, the way the backend cuts them; cursors are positions. */
function pageOf(messages: ReadonlyArray<Message>, request: MessagePageRequest): BackendResult<MessagePage> {
  let start: number;
  let end: number;
  if (request.page === "latest") {
    end = messages.length;
    start = Math.max(0, end - PAGE_SIZE);
  } else if (request.page === "around") {
    const index = messages.findIndex(({ id }) => id === request.messageId);
    if (index === -1) {
      return { ok: false, error: { code: "not_found", message: "The message was not found.", retryable: false } };
    }
    start = Math.max(0, index - 1);
    end = Math.min(messages.length, index + 2);
  } else if (request.page === "older") {
    end = Number(request.cursor);
    start = Math.max(0, end - PAGE_SIZE);
  } else {
    start = Number(request.cursor) + 1;
    end = Math.min(messages.length, start + PAGE_SIZE);
  }
  return {
    ok: true,
    value: {
      messages: messages.slice(start, end),
      olderCursor: start > 0 ? String(start) : null,
      newerCursor: end < messages.length ? String(end - 1) : null,
    },
  };
}

function installBridge(
  transcripts: Record<string, Message[]> = { atlas: [] },
  liveMessages: ConversationStateView["liveMessages"] = {},
) {
  const chats = Object.fromEntries(Object.keys(transcripts).map((id) => [id, wisp(id)]));
  const state: ConversationStateView = {
    initialized: true,
    // The full state still carries transcripts; the hook must not depend on them.
    chats: Object.fromEntries(Object.entries(chats).map(([id, chat]) => [id, { ...chat, messages: [] }])),
    statuses: Object.fromEntries(Object.keys(chats).map((id) => [id, "idle"])),
    liveMessages,
    agentEventSequence: 0,
    pendingToolApprovals: [],
    recoveredCorruptState: false,
  };
  const agentListeners = new Set<(event: SequencedConversationAgentEvent) => void>();
  const deltaListeners = new Set<(delta: ConversationDelta) => void>();
  const api = {
    getConversationState: vi.fn(async () => ({ ok: true as const, value: state })),
    initializeConversations: vi.fn(),
    getConversationMessages: vi.fn(async (request: MessagePageRequest) =>
      pageOf(transcripts[request.conversationId] ?? [], request),
    ),
    appendConversationMessage: vi.fn(
      async ({ conversationId, message }: { conversationId: string; message: Message }) => {
        const stored = transcripts[conversationId]!;
        const index = stored.findIndex(({ id }) => id === message.id);
        if (index === -1) stored.push(message);
        else stored[index] = message;
        const delta: ConversationDelta = {
          chat: chats[conversationId]!,
          added: index === -1 ? [message] : [],
          updated: index === -1 ? [] : [message],
        };
        return { ok: true as const, value: delta };
      },
    ),
    sendMessage: vi.fn(async () => ({ ok: true as const, value: {} })),
    subscribeToAgentEvents: vi.fn((listener: (event: SequencedConversationAgentEvent) => void) => {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    }),
    subscribeToConversationChanges: vi.fn((listener: (delta: ConversationDelta) => void) => {
      deltaListeners.add(listener);
      return () => deltaListeners.delete(listener);
    }),
  };
  (window as unknown as { wisp: WispApi }).wisp = api as unknown as WispApi;
  let sequence = 0;
  return {
    api,
    chats,
    emit(event: ConversationAgentEvent) {
      sequence += 1;
      act(() => {
        for (const listener of agentListeners) listener({ ...event, sequence });
      });
    },
    push(conversationId: string, changes: Partial<Pick<ConversationDelta, "added" | "updated">>, preview = "Ready") {
      act(() => {
        for (const listener of deltaListeners) {
          listener({ chat: { ...chats[conversationId]!, preview }, added: [], updated: [], ...changes });
        }
      });
    },
  };
}

async function start(conversationId?: string) {
  const hook = renderHook(() => useConversations());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  if (conversationId) {
    act(() => hook.result.current.openConversation(conversationId));
    await waitFor(() => expect(hook.result.current.windows[conversationId]).toBeDefined());
  }
  return hook;
}

function idsOf(messages: ReadonlyArray<Message> | undefined): Array<string | undefined> {
  return (messages ?? []).map(({ id }) => id);
}

async function startTurn(bridge: ReturnType<typeof installBridge>) {
  const hook = await start("atlas");
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
  it("keeps summaries for every conversation and loads messages only for the ones opened", async () => {
    const bridge = installBridge({ atlas: history(5), beta: history(1) });
    const hook = await start();

    expect(Object.keys(hook.result.current.chats)).toEqual(["atlas", "beta"]);
    expect(hook.result.current.chats.atlas).not.toHaveProperty("messages");
    expect(hook.result.current.windows).toEqual({});
    expect(bridge.api.getConversationMessages).not.toHaveBeenCalled();

    act(() => hook.result.current.openConversation("atlas"));
    await waitFor(() => expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m3", "m4"]));
    expect(hook.result.current.windows.atlas).toMatchObject({ olderCursor: "3", newerCursor: null, loading: false });
    expect(hook.result.current.windows.beta).toBeUndefined();
  });

  it("adds older pages above the window until the transcript starts", async () => {
    installBridge({ atlas: history(5) });
    const hook = await start("atlas");

    act(() => hook.result.current.loadOlderMessages("atlas"));
    expect(hook.result.current.windows.atlas?.loading).toBe(true);
    await waitFor(() => expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m1", "m2", "m3", "m4"]));
    act(() => hook.result.current.loadOlderMessages("atlas"));
    await waitFor(() => expect(hook.result.current.windows.atlas?.olderCursor).toBeNull());

    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(hook.result.current.windows.atlas?.epoch).toBe(1);
  });

  it("keeps windows for the five conversations opened most recently", async () => {
    const bridge = installBridge({ a: history(1), b: history(1), c: history(1), d: history(1), e: history(1), f: [] });
    const hook = await start();

    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      act(() => hook.result.current.openConversation(id));
      await waitFor(() => expect(hook.result.current.windows[id]).toBeDefined());
    }
    expect(Object.keys(hook.result.current.windows).sort()).toEqual(["b", "c", "d", "e", "f"]);

    // A kept window is shown as it is; an evicted one is read again.
    act(() => hook.result.current.openConversation("b"));
    expect(bridge.api.getConversationMessages).toHaveBeenCalledTimes(6);
    act(() => hook.result.current.openConversation("a"));
    await waitFor(() => expect(hook.result.current.windows.a).toBeDefined());
    expect(bridge.api.getConversationMessages).toHaveBeenCalledTimes(7);
    expect(hook.result.current.windows.c).toBeUndefined();
  });

  it("applies a change to the summary alone when the conversation has no window", async () => {
    const bridge = installBridge({ atlas: history(1), beta: history(1) });
    const hook = await start("atlas");

    bridge.push("beta", { added: [{ id: "new", type: "incoming", text: "Done" }] }, "Done");

    expect(hook.result.current.chats.beta?.preview).toBe("Done");
    expect(hook.result.current.windows.beta).toBeUndefined();
    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m0"]);
  });

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
    expect(bridge.api.getConversationMessages).toHaveBeenCalledTimes(1);
    expect(hook.result.current.windows.atlas?.messages).toEqual([
      expect.objectContaining({ id: requestId, type: "outgoing", status: "complete" }),
      expect.objectContaining({ id: "reply", type: "incoming", text: "Hi there", status: "complete" }),
    ]);
  });

  it("applies a pushed change and drops transient copies the backend has settled", async () => {
    const bridge = installBridge();
    const { hook, outgoing, requestId } = await startTurn(bridge);
    bridge.emit({ type: "assistant_message_completed", conversationId: "atlas", requestId, messageId: "reply" });
    const delivered: Message = { ...outgoing, status: "complete" };
    const reply: Message = {
      id: "reply",
      type: "incoming",
      text: "Hi",
      status: "complete",
      createdAt: "2026-09-29T12:00:01.000Z",
    };

    bridge.push("atlas", { updated: [delivered] });
    bridge.push("atlas", { added: [reply] }, "Hi");

    expect(hook.result.current.chats.atlas?.preview).toBe("Hi");
    const messages = hook.result.current.windows.atlas?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(delivered);
    expect(messages[1]).toBe(reply);
  });

  it("keeps the newer streaming copy when a stored change arrives mid-reply", async () => {
    const bridge = installBridge();
    const { hook, outgoing, requestId } = await startTurn(bridge);

    bridge.push("atlas", { updated: [{ ...outgoing, status: "complete" }] });
    bridge.emit({ type: "assistant_text_delta", conversationId: "atlas", requestId, messageId: "reply", delta: "!" });

    expect(hook.result.current.windows.atlas?.messages.at(-1)).toEqual(
      expect.objectContaining({ id: "reply", text: "Hi!", status: "streaming" }),
    );
  });

  it("continues a reply that was already streaming when the renderer started", async () => {
    const bridge = installBridge(
      { atlas: history(1) },
      { atlas: [{ id: "reply", type: "incoming", text: "So far", status: "streaming" }] },
    );
    const hook = await start("atlas");

    bridge.emit({
      type: "assistant_text_delta",
      conversationId: "atlas",
      requestId: "r",
      messageId: "reply",
      delta: "!",
    });

    expect(hook.result.current.windows.atlas?.messages).toEqual([
      expect.objectContaining({ id: "m0" }),
      expect.objectContaining({ id: "reply", text: "So far!", status: "streaming" }),
    ]);
  });

  it("opens a conversation around a message, detached, and reattaches by loading newer pages", async () => {
    const bridge = installBridge({ atlas: history(6) });
    const hook = await start("atlas");

    await act(() => hook.result.current.openMessage("atlas", "m1"));
    expect(hook.result.current.windows.atlas).toMatchObject({ epoch: 2, targetMessageId: "m1", newerCursor: "2" });
    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m0", "m1", "m2"]);

    // New messages stay out of a detached window; a change to a message it holds still shows.
    bridge.push("atlas", {
      added: [{ id: "new", type: "incoming", text: "Later" }],
      updated: [{ id: "m1", type: "incoming", text: "Edited" }],
    });
    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m0", "m1", "m2"]);
    expect(hook.result.current.windows.atlas?.messages[1]).toMatchObject({ text: "Edited" });

    act(() => hook.result.current.loadNewerMessages("atlas"));
    await waitFor(() => expect(hook.result.current.windows.atlas?.newerCursor).toBe("4"));
    act(() => hook.result.current.loadNewerMessages("atlas"));
    await waitFor(() => expect(hook.result.current.windows.atlas?.newerCursor).toBeNull());
    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
    expect(hook.result.current.windows.atlas?.epoch).toBe(2);
  });

  it("jumps from a detached window back to the newest messages", async () => {
    installBridge({ atlas: history(6) });
    const hook = await start("atlas");
    await act(() => hook.result.current.openMessage("atlas", "m1"));

    act(() => hook.result.current.openConversation("atlas"));
    await waitFor(() => expect(hook.result.current.windows.atlas?.epoch).toBe(3));

    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m4", "m5"]);
    expect(hook.result.current.windows.atlas).toMatchObject({ newerCursor: null });
    expect(hook.result.current.windows.atlas).not.toHaveProperty("targetMessageId");
  });

  it("opens the newest messages when the message to jump to is gone", async () => {
    installBridge({ atlas: history(3) });
    const hook = await start();

    await act(() => hook.result.current.openMessage("atlas", "deleted"));
    await waitFor(() => expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m1", "m2"]));

    expect(hook.result.current.windows.atlas).not.toHaveProperty("targetMessageId");
    expect(hook.result.current.error).toBeNull();
  });

  it("keeps a message that was stored while the page holding the window was being read", async () => {
    const bridge = installBridge({ atlas: history(2) });
    const hook = await start();
    let deliver = (_page: BackendResult<MessagePage>): void => undefined;
    bridge.api.getConversationMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );

    act(() => hook.result.current.openConversation("atlas"));
    // The page was read before this message was stored, so only the pushed change carries it.
    bridge.push("atlas", { added: [{ id: "new", type: "incoming", text: "Just stored" }] });
    await act(async () => deliver(pageOf(history(2), { conversationId: "atlas", page: "latest" })));

    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m0", "m1", "new"]);
  });

  it("returns to the newest messages to send, and finds a message to retry outside the window", async () => {
    const failed: Message = { id: "old-request", type: "outgoing", text: "Try me", status: "failed" };
    const bridge = installBridge({ atlas: [failed, ...history(4)] });
    const hook = await start("atlas");
    expect(idsOf(hook.result.current.windows.atlas?.messages)).toEqual(["m2", "m3"]);
    await act(() => hook.result.current.openMessage("atlas", "m1"));

    await act(async () => {
      await hook.result.current.retryMessage("atlas", "old-request");
    });

    expect(bridge.api.appendConversationMessage).toHaveBeenCalledWith({
      conversationId: "atlas",
      message: expect.objectContaining({ type: "outgoing", text: "Try me" }),
    });
    await waitFor(() => expect(hook.result.current.windows.atlas?.newerCursor).toBeNull());
    expect(hook.result.current.windows.atlas?.messages.at(-1)).toMatchObject({ type: "outgoing", text: "Try me" });
  });
});
