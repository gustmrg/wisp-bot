import {
  WISP_IPC_CHANNELS,
  type ConversationStatus,
  type SequencedConversationAgentEvent,
  type SystemNotificationKind,
  type SystemNotificationSettings,
  type SystemNotificationTarget,
} from "../shared/contracts.js";
import type { ConnectionsView } from "../shared/connections.js";
import type { ChatSummary, ConversationDelta, ConversationStateView, Message } from "../shared/conversations.js";

export const DEFAULT_SYSTEM_NOTIFICATION_SETTINGS: SystemNotificationSettings = {
  enabled: true,
  onCompletion: true,
  onApproval: true,
  onError: true,
};

/** A notification's body is cut to about this many characters. */
const BODY_LENGTH = 120;
/** How much of a reply is kept while it streams: enough for the body. */
const KEPT_REPLY_LENGTH = 1_000;
/** Job messages remembered for their notification, newest last. */
const KEPT_JOB_MESSAGES = 20;

export interface SystemNotification {
  title: string;
  body: string;
  target: SystemNotificationTarget;
}

/** What the notifier needs from the app and the operating system; tests substitute a fake. */
export interface SystemNotificationHost {
  show(notification: SystemNotification): void;
  /** Sets the count on the Dock icon or taskbar button; zero clears it. */
  setBadge(count: number): void;
  /** Bounces the Dock icon or flashes the taskbar button until the app is focused. */
  requestAttention(): void;
  /** Whether a window of the app has focus. */
  windowFocused(): boolean;
  /** The active connection's conversations, or undefined while there is none. */
  loadState(): Promise<ConversationStateView | undefined>;
}

interface ChatInfo {
  kind: ChatSummary["kind"];
  /** The Wisp's ID for its own conversation, or the circle's name. */
  wispId?: string;
  name?: string;
  notify: boolean;
  unread: boolean;
}

const SAMPLES: Record<SystemNotificationKind, string> = {
  finished: "Here is what I found.",
  "needs-input": "Needs approval: Modify notes.md",
  error: "The model could not answer. Try again.",
};

/**
 * Turns what the active Wisp server pushes into native notifications and the
 * Dock or taskbar badge. It runs in the main process, so it keeps notifying
 * with every window closed, while the app stays in the tray or the Dock. It
 * notifies for the same events, and with the same rules, as the renderer's
 * notification sounds; only live transitions notify, never a snapshot.
 */
export class SystemNotifier {
  private settings = DEFAULT_SYSTEM_NOTIFICATION_SETTINGS;
  private focusedConversation: string | null = null;
  private readonly wispNames = new Map<string, string>();
  private readonly chats = new Map<string, ChatInfo>();
  /** Pending approvals, by approval ID, with their conversation. */
  private readonly approvals = new Map<string, string>();
  private readonly statuses = new Map<string, ConversationStatus>();
  /** Conversations whose current turn failed or was stopped: its end is not a finished reply. */
  private readonly unsuccessful = new Set<string>();
  /** The reply part each conversation is writing, cut to what a body needs. */
  private readonly replies = new Map<string, string>();
  private readonly jobMessages = new Map<string, string>();
  /** The connection the conversations above belong to. */
  private loadedConnection: string | undefined;
  private loading: Promise<void> | undefined;
  private lastBadge = -1;

  constructor(private readonly host: SystemNotificationHost) {}

  configure(settings: SystemNotificationSettings): void {
    this.settings = settings;
  }

  /** The conversation open in the app; it is not notified about while a window has focus. */
  setFocus(conversationId: string | null): void {
    this.focusedConversation = conversationId;
  }

  test(kind: SystemNotificationKind): void {
    this.host.show({ title: "Wisp", body: SAMPLES[kind], target: { conversationId: "" } });
  }

  /** Sees every payload the app pushes to its windows. */
  handlePush(channel: string, payload: unknown): void {
    if (channel === WISP_IPC_CHANNELS.agentEvent) this.handleAgentEvent(payload as SequencedConversationAgentEvent);
    else if (channel === WISP_IPC_CHANNELS.conversationChanged) this.handleChange(payload as ConversationDelta);
    else if (channel === WISP_IPC_CHANNELS.connectionsChanged) this.handleConnections(payload as ConnectionsView);
  }

  /** Settles a reload in progress; for tests. */
  async idle(): Promise<void> {
    await this.loading;
  }

  private handleConnections(view: ConnectionsView): void {
    const { status } = view;
    if (status.phase !== "local" && status.phase !== "connected") return;
    const connection = `${status.profileId}:${status.epoch}`;
    if (connection === this.loadedConnection) return;
    this.loadedConnection = connection;
    void this.reload();
  }

  /** Loads the conversations again, such as once the backend is ready to give them. */
  refresh(): Promise<void> {
    return this.reload();
  }

  /** Sets the badge again, such as on a window that just opened. */
  reapplyBadge(): void {
    this.lastBadge = -1;
    this.updateBadge();
  }

  private reload(): Promise<void> {
    const loading = this.host
      .loadState()
      .then((state) => {
        // Nothing to load yet: the next connection change tries again.
        if (!state) {
          this.loadedConnection = undefined;
          return;
        }
        this.wispNames.clear();
        for (const wisp of Object.values(state.wisps)) this.wispNames.set(wisp.id, wisp.name);
        this.chats.clear();
        for (const chat of Object.values(state.chats)) this.chats.set(chat.id, chatInfo(chat));
        this.approvals.clear();
        for (const request of state.pendingToolApprovals)
          this.approvals.set(request.approvalId, request.conversationId);
        this.statuses.clear();
        for (const [id, status] of Object.entries(state.statuses)) {
          if (status === "working" || status === "idle") this.statuses.set(id, status);
        }
        this.updateBadge();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.loading === loading) this.loading = undefined;
      });
    this.loading = loading;
    return loading;
  }

  private handleChange(delta: ConversationDelta): void {
    this.chats.set(delta.chat.id, chatInfo(delta.chat));
    for (const message of [...delta.added, ...delta.updated]) this.rememberJobMessage(message);
    this.updateBadge();
  }

  private rememberJobMessage(message: Message): void {
    if (message.type !== "incoming" || !message.job || !message.id) return;
    this.jobMessages.delete(message.id);
    this.jobMessages.set(message.id, message.text.slice(0, KEPT_REPLY_LENGTH));
    for (const id of this.jobMessages.keys()) {
      if (this.jobMessages.size <= KEPT_JOB_MESSAGES) break;
      this.jobMessages.delete(id);
    }
  }

  private handleAgentEvent(event: SequencedConversationAgentEvent): void {
    const id = event.conversationId;
    switch (event.type) {
      case "conversation_status": {
        const previous = this.statuses.get(id);
        if (event.status === "disposed") {
          this.statuses.delete(id);
          this.unsuccessful.delete(id);
          this.replies.delete(id);
          return;
        }
        this.statuses.set(id, event.status);
        if (event.status === "working" && previous !== "working") this.unsuccessful.delete(id);
        if (previous === "working" && event.status === "idle" && !this.unsuccessful.has(id)) {
          void this.notify(id, "finished", this.replies.get(id) || "Finished.");
        }
        return;
      }
      case "assistant_message_started":
        this.replies.set(id, "");
        return;
      case "assistant_text_delta": {
        const text = this.replies.get(id) ?? "";
        if (text.length < KEPT_REPLY_LENGTH) this.replies.set(id, (text + event.delta).slice(0, KEPT_REPLY_LENGTH));
        return;
      }
      case "conversation_error":
        // Errors without a request (e.g. a rejected model change) are not turn failures.
        if (!event.requestId) return;
        this.unsuccessful.add(id);
        void this.notify(id, "error", event.error.message);
        return;
      case "assistant_message_cancelled":
        this.unsuccessful.add(id);
        return;
      case "tool_approval_requested":
        this.approvals.set(event.request.approvalId, id);
        this.updateBadge();
        void this.notify(id, "needs-input", `Needs approval: ${event.request.summary}`, event.request.approvalId);
        return;
      case "tool_approval_resolved":
        this.approvals.delete(event.approvalId);
        this.updateBadge();
        return;
      case "job_message_delivered":
        void this.notify(id, "finished", this.jobMessages.get(event.messageId) || "Sent an update from a job.");
        return;
    }
  }

  private async notify(
    conversationId: string,
    kind: SystemNotificationKind,
    text: string,
    approvalId?: string,
  ): Promise<void> {
    const { settings } = this;
    const enabled =
      kind === "finished" ? settings.onCompletion : kind === "needs-input" ? settings.onApproval : settings.onError;
    if (!settings.enabled || !enabled) return;
    // A Wisp created since the last load is not known yet.
    if (!this.chats.has(conversationId)) await (this.loading ?? this.reload());
    const chat = this.chats.get(conversationId);
    if (!chat || chat.kind !== "wisp" || !chat.notify) return;
    if (this.host.windowFocused() && this.focusedConversation === conversationId) return;
    if (kind === "needs-input" && !this.host.windowFocused()) this.host.requestAttention();
    this.host.show({
      title: (chat.wispId && this.wispNames.get(chat.wispId)) || "Wisp",
      body: notificationBody(text),
      target: { conversationId, ...(approvalId ? { approvalId } : {}) },
    });
  }

  private updateBadge(): void {
    let count = this.approvals.size;
    for (const chat of this.chats.values()) if (chat.unread) count += 1;
    if (count === this.lastBadge) return;
    this.lastBadge = count;
    this.host.setBadge(count);
  }
}

function chatInfo(chat: ChatSummary): ChatInfo {
  return {
    kind: chat.kind,
    ...(chat.kind === "wisp" ? { wispId: chat.wispId } : { name: chat.name }),
    notify: chat.notifyOnUpdatesEnabled,
    unread: Boolean(chat.unread || chat.unreadCount),
  };
}

/** A reply as plain words on a line or two: no Markdown marks, links as their text, and cut short. */
export function notificationBody(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/gu, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gmu, "")
    .replace(/[*_~`]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length > BODY_LENGTH ? `${plain.slice(0, BODY_LENGTH - 1).trimEnd()}…` : plain;
}
