import type { ConnectionPhase, ConnectionPushedEventType, EnvironmentSummary } from "../../shared/connections.js";
import type { ConversationAgentEvent } from "../../shared/contracts.js";
import type { ConversationDelta, ConversationStateView, WispsView } from "../../shared/conversations.js";

interface TrackedChat {
  kind: "wisp" | "circle";
  unread: boolean;
}

/**
 * Maintains one environment's live operational summary (`EnvironmentSummary`)
 * from an initial `getConversationState` snapshot and subsequent pushed events.
 * Mutation methods return `true` only when the visible summary changed so the
 * connection manager avoids publishing redundant `connectionsChanged` updates
 * during high-frequency streaming events.
 */
export class EnvironmentSummaryTracker {
  private phase: ConnectionPhase;
  private message: string | undefined;
  private serverVersion: string | undefined;
  private readonly wispIds = new Set<string>();
  private readonly chats = new Map<string, TrackedChat>();
  private readonly workingConversations = new Set<string>();
  private readonly pendingApprovalIds = new Set<string>();
  private lastSnapshot: EnvironmentSummary;

  constructor(
    private readonly profileId: string,
    initialPhase: ConnectionPhase,
    initialMessage?: string,
  ) {
    this.phase = initialPhase;
    this.message = initialMessage;
    this.lastSnapshot = this.compute();
  }

  /** Returns an immutable copy of the current operational summary. */
  snapshot(): EnvironmentSummary {
    return { ...this.lastSnapshot };
  }

  /** Updates connection lifecycle fields; returns true when the summary changed. */
  setConnection(phase: ConnectionPhase, message?: string, serverVersion?: string): boolean {
    this.phase = phase;
    this.message = message;
    if (serverVersion !== undefined) this.serverVersion = serverVersion;
    return this.commit();
  }

  /** Replaces tracked counts from a full `ConversationStateView` snapshot. */
  applySnapshot(state: ConversationStateView): boolean {
    this.wispIds.clear();
    for (const id of Object.keys(state.wisps ?? {})) {
      this.wispIds.add(id);
    }
    this.chats.clear();
    for (const chat of Object.values(state.chats ?? {})) {
      this.chats.set(chat.id, { kind: chat.kind, unread: isUnread(chat) });
    }
    this.workingConversations.clear();
    for (const [conversationId, status] of Object.entries(state.statuses ?? {})) {
      if (status === "working") this.workingConversations.add(conversationId);
    }
    this.pendingApprovalIds.clear();
    for (const request of state.pendingToolApprovals ?? []) {
      this.pendingApprovalIds.add(request.approvalId);
    }
    return this.commit();
  }

  /** Applies one pushed runtime event; returns true when any summary count changed. */
  applyEvent(type: ConnectionPushedEventType, payload: unknown): boolean {
    if (type === "agentEvent") {
      const event = payload as ConversationAgentEvent | null | undefined;
      if (!event || typeof event !== "object") return false;
      if (event.type === "conversation_status") {
        if (event.status === "working") this.workingConversations.add(event.conversationId);
        else this.workingConversations.delete(event.conversationId);
        return this.commit();
      }
      if (event.type === "tool_approval_requested") {
        if (event.request?.approvalId) this.pendingApprovalIds.add(event.request.approvalId);
        return this.commit();
      }
      if (event.type === "tool_approval_resolved") {
        if (event.approvalId) this.pendingApprovalIds.delete(event.approvalId);
        return this.commit();
      }
      return false;
    }

    if (type === "conversationChanged") {
      const delta = payload as ConversationDelta | null | undefined;
      if (!delta?.chat?.id) return false;
      this.chats.set(delta.chat.id, { kind: delta.chat.kind, unread: isUnread(delta.chat) });
      return this.commit();
    }

    if (type === "wispsChanged") {
      const view = payload as WispsView | null | undefined;
      if (!view || typeof view !== "object") return false;
      this.wispIds.clear();
      for (const id of Object.keys(view.wisps ?? {})) {
        this.wispIds.add(id);
      }
      this.chats.clear();
      for (const chat of Object.values(view.chats ?? {})) {
        this.chats.set(chat.id, { kind: chat.kind, unread: isUnread(chat) });
      }
      this.workingConversations.clear();
      for (const [conversationId, status] of Object.entries(view.statuses ?? {})) {
        if (status === "working") this.workingConversations.add(conversationId);
      }
      return this.commit();
    }

    return false;
  }

  private compute(): EnvironmentSummary {
    let unreadConversations = 0;
    let circleCount = 0;
    for (const chat of this.chats.values()) {
      if (chat.unread) unreadConversations++;
      if (chat.kind === "circle") circleCount++;
    }
    return {
      profileId: this.profileId,
      phase: this.phase,
      ...(this.message ? { message: this.message } : {}),
      ...(this.serverVersion ? { serverVersion: this.serverVersion } : {}),
      workingWisps: this.workingConversations.size,
      pendingApprovals: this.pendingApprovalIds.size,
      unreadConversations,
      wispCount: this.wispIds.size,
      circleCount,
    };
  }

  private commit(): boolean {
    const next = this.compute();
    if (summariesEqual(this.lastSnapshot, next)) return false;
    this.lastSnapshot = next;
    return true;
  }
}

function isUnread(chat: { unread?: boolean; unreadCount?: number }): boolean {
  return chat.unread === true || (typeof chat.unreadCount === "number" && chat.unreadCount > 0);
}

function summariesEqual(a: EnvironmentSummary, b: EnvironmentSummary): boolean {
  return (
    a.profileId === b.profileId &&
    a.phase === b.phase &&
    a.message === b.message &&
    a.serverVersion === b.serverVersion &&
    a.workingWisps === b.workingWisps &&
    a.pendingApprovals === b.pendingApprovals &&
    a.unreadConversations === b.unreadConversations &&
    a.wispCount === b.wispCount &&
    a.circleCount === b.circleCount
  );
}
