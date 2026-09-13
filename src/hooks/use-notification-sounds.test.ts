import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { playNotificationSound } = vi.hoisted(() => ({ playNotificationSound: vi.fn() }));

vi.mock("@/lib/notification-sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notification-sounds")>()),
  playNotificationSound,
}));

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
    renderHook(() => useNotificationSounds({ enabled: true, chats: { atlas: wispChat("atlas") } }));

    emit(statusEvent("atlas", "working", 1));
    emit(statusEvent("atlas", "idle", 2));

    expect(playNotificationSound).toHaveBeenCalledWith("finished");
  });

  it("stays silent for a first status that has no prior working state", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ enabled: true, chats: { atlas: wispChat("atlas") } }));

    emit(statusEvent("atlas", "idle", 1));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("stays silent while the Wisp keeps working or is disposed", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ enabled: true, chats: { atlas: wispChat("atlas") } }));

    emit(statusEvent("atlas", "working", 1));
    emit(statusEvent("atlas", "working", 2));
    emit(statusEvent("atlas", "disposed", 3));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("chimes when a Wisp requests a tool approval", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ enabled: true, chats: { atlas: wispChat("atlas") } }));

    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });

    expect(playNotificationSound).toHaveBeenCalledWith("needs-input");
  });

  it("respects the per-Wisp notification toggle", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ enabled: true, chats: { atlas: wispChat("atlas", false) } }));

    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });
    emit(statusEvent("atlas", "working", 2));
    emit(statusEvent("atlas", "idle", 3));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("respects the app-level notification setting", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ enabled: false, chats: { atlas: wispChat("atlas") } }));

    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });
    emit(statusEvent("atlas", "working", 2));
    emit(statusEvent("atlas", "idle", 3));

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("ignores chats that are not Wisps", () => {
    const emit = installBridge();
    renderHook(() => useNotificationSounds({ enabled: true, chats: { team: circleChat("team") } }));

    emit({ type: "tool_approval_requested", conversationId: "team", request: approvalRequest("team"), sequence: 1 });

    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("applies chat changes without resubscribing", () => {
    const emit = installBridge();
    const { rerender } = renderHook(({ chats }) => useNotificationSounds({ enabled: true, chats }), {
      initialProps: { chats: { atlas: wispChat("atlas", true) } },
    });

    rerender({ chats: { atlas: wispChat("atlas", false) } });
    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 1 });
    expect(playNotificationSound).not.toHaveBeenCalled();

    rerender({ chats: { atlas: wispChat("atlas", true) } });
    emit({ type: "tool_approval_requested", conversationId: "atlas", request: approvalRequest("atlas"), sequence: 2 });
    expect(playNotificationSound).toHaveBeenCalledWith("needs-input");
  });
});
