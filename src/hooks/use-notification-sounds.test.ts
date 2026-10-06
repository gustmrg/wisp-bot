import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }));

vi.mock("@/lib/notification-sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notification-sounds")>()),
  playNotificationSound,
}));

import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import { useNotificationSounds } from "@/hooks/use-notification-sounds";
import type { SequencedConversationAgentEvent, WispApi } from "../../shared/contracts";
import type { Chat, ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

type AgentEventListener = (event: SequencedConversationAgentEvent) => void;

function installBridge() {
  const listeners = new Set<AgentEventListener>();
  (window as unknown as { wisp: WispApi }).wisp = {
    subscribeToAgentEvents: vi.fn((listener: AgentEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as WispApi;
  return (event: SequencedConversationAgentEvent) => {
    act(() => {
      for (const listener of listeners) listener(event);
    });
  };
}

function wispChat(id: string, notifyOnUpdatesEnabled = true): Chat {
  return {
    id,
    name: id,
    label: "Research",
    description: "",
    kind: "wisp",
    shape: "circle",
    notifyOnUpdatesEnabled,
    preview: "Ready",
    timestamp: "Now",
    messages: [],
  };
}

function circleChat(id: string): Chat {
  return {
    id,
    name: id,
    label: "Team",
    description: "",
    kind: "circle",
    notifyOnUpdatesEnabled: true,
    memberIds: [],
    preview: "",
    timestamp: "Now",
    messages: [],
  };
}

function statusEvent(
  conversationId: string,
  status: ManagedConversationStatus,
  sequence: number,
): SequencedConversationAgentEvent {
  return { type: "conversation_status", conversationId, status, sequence };
}

function approvalRequest(conversationId: string): ToolApprovalRequest {
  return {
    approvalId: `${conversationId}-approval-1`,
    conversationId,
    toolCallId: "tool-1",
    toolName: "shell",
    category: "shell",
    scope: { kind: "workspace_path", display: "~/Dev/wisp-bot" },
    summary: "Run the test suite",
    expiresAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("useNotificationSounds", () => {
  afterEach(() => {
    delete (window as { wisp?: unknown }).wisp;
  });

  it("chimes when a Wisp settles from working to idle", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));

    emit(statusEvent("atlas", "working", 1));
    emit(statusEvent("atlas", "idle", 2));

    expect(playNotificationSound).toHaveBeenCalledWith("finished", 100);
  });

  it("stays silent for a first status that has no prior working state", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));

    emit(statusEvent("atlas", "idle", 1));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("stays silent while the Wisp keeps working or is disposed", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));

    emit(statusEvent("atlas", "working", 1));
    emit(statusEvent("atlas", "working", 2));
    emit(statusEvent("atlas", "disposed", 3));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("chimes when a Wisp requests a tool approval", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));

    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });

    expect(playNotificationSound).toHaveBeenCalledWith("needs-input", 100);
  });

  it("respects the per-Wisp notification toggle", () => {
    const emit = installBridge();
    renderHook(() =>
      useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas", false) } }),
    );

    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });
    emit(statusEvent("atlas", "working", 2));
    emit(statusEvent("atlas", "idle", 3));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("respects the app-level notification setting", () => {
    const emit = installBridge();
    renderHook(() =>
      useNotificationSounds({
        preferences: { ...DEFAULT_PREFERENCES, notificationSounds: false },
        chats: { atlas: wispChat("atlas") },
      }),
    );

    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });
    emit(statusEvent("atlas", "working", 2));
    emit(statusEvent("atlas", "idle", 3));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("ignores chats that are not Wisps", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { team: circleChat("team") } }));

    emit({ type: "tool_approval_requested", conversationId: "team", request: approvalRequest("team"), sequence: 1 });

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("applies chat changes without resubscribing", () => {
    const emit = installBridge();
    const { rerender } = renderHook(({ chats }) => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats }), {
      initialProps: { chats: { atlas: wispChat("atlas", true) } },
    });

    rerender({ chats: { atlas: wispChat("atlas", false) } });
    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });
    expect(playNotificationSound).not.toHaveBeenCalled();

    rerender({ chats: { atlas: wispChat("atlas", true) } });
    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 2 });
    expect(playNotificationSound).toHaveBeenCalledWith("needs-input", 100);
  });

  it("applies event filters and volume without resubscribing", () => {
    const emit = installBridge();
    const { rerender } = renderHook(
      ({ preferences }) => useNotificationSounds({ preferences, chats: { atlas: wispChat("atlas") } }),
      {
        initialProps: { preferences: { ...DEFAULT_PREFERENCES, notifyOnCompletion: false, notificationVolume: 35 } },
      },
    );
    emit(statusEvent("atlas", "working", 1));
    emit(statusEvent("atlas", "idle", 2));
    expect(playNotificationSound).not.toHaveBeenCalled();
    rerender({ preferences: { ...DEFAULT_PREFERENCES, notifyOnCompletion: true, notificationVolume: 35 } });
    emit(statusEvent("atlas", "working", 3));
    emit(statusEvent("atlas", "idle", 4));
    expect(playNotificationSound).toHaveBeenCalledWith("finished", 35);
    expect(window.wisp.subscribeToAgentEvents).toHaveBeenCalledTimes(1);
  });

  it("does not announce success after an error, and recovers on the next turn", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));
    emit(statusEvent("atlas", "working", 1));
    emit({
      type: "conversation_error",
      conversationId: "atlas",
      sequence: 2,
      requestId: "request",
      createdAt: "2026-10-06",
      error: { code: "internal_error", message: "Failed", retryable: true },
    });
    emit(statusEvent("atlas", "idle", 3));
    expect(playNotificationSound).toHaveBeenCalledExactlyOnceWith("error", 100);
    emit(statusEvent("atlas", "working", 4));
    emit(statusEvent("atlas", "idle", 5));
    expect(playNotificationSound).toHaveBeenLastCalledWith("finished", 100);
  });

  it("mutes the selected conversation only while visible and focused", () => {
    const emit = installBridge();
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    renderHook(() =>
      useNotificationSounds({
        preferences: { ...DEFAULT_PREFERENCES, muteActiveConversation: true },
        chats: { atlas: wispChat("atlas"), other: wispChat("other") },
        activeChatId: "atlas",
      }),
    );
    emit(statusEvent("atlas", "working", 1));
    emit(statusEvent("atlas", "idle", 2));
    expect(playNotificationSound).not.toHaveBeenCalled();
    emit(statusEvent("other", "working", 3));
    emit(statusEvent("other", "idle", 4));
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
    focus.mockReturnValue(false);
    emit(statusEvent("atlas", "working", 5));
    emit(statusEvent("atlas", "idle", 6));
    expect(playNotificationSound).toHaveBeenCalledTimes(2);
  });

  it("tracks transitions while disabled so re-enabling cannot replay an old completion", () => {
    const emit = installBridge();
    const { rerender } = renderHook(
      ({ enabled }) =>
        useNotificationSounds({
          preferences: { ...DEFAULT_PREFERENCES, notificationSounds: enabled },
          chats: { atlas: wispChat("atlas") },
        }),
      { initialProps: { enabled: true } },
    );
    emit(statusEvent("atlas", "working", 1));
    rerender({ enabled: false });
    emit(statusEvent("atlas", "idle", 2));
    rerender({ enabled: true });
    emit(statusEvent("atlas", "idle", 3));
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it.each(["notifyOnApproval", "notifyOnError"] as const)("respects %s independently", (key) => {
    const emit = installBridge();
    renderHook(() =>
      useNotificationSounds({
        preferences: { ...DEFAULT_PREFERENCES, [key]: false },
        chats: { atlas: wispChat("atlas") },
      }),
    );
    if (key === "notifyOnApproval")
      emit({
        type: "tool_approval_requested",
        conversationId: "atlas",
        request: approvalRequest("atlas"),
        sequence: 1,
      });
    else
      emit({
        type: "conversation_error",
        conversationId: "atlas",
        sequence: 1,
        requestId: "request",
        createdAt: "2026-10-06",
        error: { code: "internal_error", message: "Failed", retryable: true },
      });
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("ignores errors that do not belong to a turn", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));
    emit(statusEvent("atlas", "working", 1));
    emit({
      type: "conversation_error",
      conversationId: "atlas",
      sequence: 2,
      createdAt: "2026-10-06",
      error: { code: "invalid_request", message: "The model change could not be applied.", retryable: true },
    });
    emit(statusEvent("atlas", "idle", 3));
    expect(playNotificationSound).toHaveBeenCalledExactlyOnceWith("finished", 100);
  });

  it("does not play completion for cancelled turns", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ preferences: DEFAULT_PREFERENCES, chats: { atlas: wispChat("atlas") } }));
    emit(statusEvent("atlas", "working", 1));
    emit({
      type: "assistant_message_cancelled",
      conversationId: "atlas",
      sequence: 2,
      requestId: "request",
      messageId: "message",
    });
    emit(statusEvent("atlas", "idle", 3));
    expect(playNotificationSound).not.toHaveBeenCalled();
  });
});
