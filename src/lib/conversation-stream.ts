import type { BackendError, ConversationAgentEvent, SequencedConversationAgentEvent } from "../../shared/contracts";
import {
  assistantMessageId,
  type ManagedConversationStatus,
  type Message,
  type TextMessage,
} from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";
import { describeMcpAlias, getToolMetadata } from "../../shared/tool-catalog";

export interface ToolActivityView {
  toolCallId: string;
  toolName: string;
  phase: "started" | "updated" | "completed";
  isError?: boolean;
}

export interface ConversationRuntimeState {
  sequence: number;
  statuses: Record<string, ManagedConversationStatus>;
  messages: Record<string, ReadonlyArray<Message>>;
  errors: Record<string, BackendError | undefined>;
  activity: Record<string, string | undefined>;
  toolActivities: Record<string, ReadonlyArray<ToolActivityView>>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
}

/** Stored state the stream reads: which conversations exist, and the messages loaded for them. */
export interface StoredConversations {
  chats: Readonly<Record<string, unknown>>;
  windows: Readonly<Record<string, { messages: ReadonlyArray<Message> } | undefined>>;
}

/**
 * `liveMessages` are the messages the backend had not stored yet at `sequence`
 * (replies still streaming or being saved), so later events apply on top of them.
 */
export function createConversationRuntime(
  sequence: number,
  statuses: Record<string, ManagedConversationStatus>,
  pendingApprovals: ReadonlyArray<ToolApprovalRequest> = [],
  liveMessages: Record<string, ReadonlyArray<Message>> = {},
): ConversationRuntimeState {
  return {
    sequence,
    statuses,
    messages: liveMessages,
    errors: {},
    activity: {},
    toolActivities: {},
    approvals: groupApprovals(pendingApprovals),
  };
}

function groupApprovals(
  approvals: ReadonlyArray<ToolApprovalRequest>,
): Record<string, ReadonlyArray<ToolApprovalRequest>> {
  const grouped: Record<string, ToolApprovalRequest[]> = {};
  for (const approval of approvals) {
    (grouped[approval.conversationId] ??= []).push(approval);
  }
  return grouped;
}

export function stageOutgoingMessage(
  state: ConversationRuntimeState,
  conversationId: string,
  message: TextMessage & { id: string },
): ConversationRuntimeState {
  return setRuntimeMessage(
    {
      ...state,
      errors: { ...state.errors, [conversationId]: undefined },
    },
    conversationId,
    { ...message, status: "queued" },
  );
}

/** Shows an error in the conversation's composer until the next message or reply. */
export function setConversationError(
  state: ConversationRuntimeState,
  conversationId: string,
  error: BackendError,
): ConversationRuntimeState {
  return { ...state, errors: { ...state.errors, [conversationId]: error } };
}

export function clearConversationError(
  state: ConversationRuntimeState,
  conversationId: string,
): ConversationRuntimeState {
  if (!state.errors[conversationId]) return state;
  return { ...state, errors: { ...state.errors, [conversationId]: undefined } };
}

export function markOutgoingFailed(
  state: ConversationRuntimeState,
  stored: StoredConversations,
  conversationId: string,
  requestId: string,
  error: BackendError,
): ConversationRuntimeState {
  let next = {
    ...state,
    errors: { ...state.errors, [conversationId]: error },
  };
  const outgoing = findMessage(next, stored, conversationId, requestId);
  if (outgoing?.type === "outgoing") {
    next = setRuntimeMessage(next, conversationId, { ...outgoing, id: requestId, status: "failed" });
  }
  return setRuntimeMessage(next, conversationId, {
    id: assistantMessageId(requestId),
    type: "incoming",
    text: error.message,
    status: "failed",
    retryable: error.retryable,
    createdAt: new Date().toISOString(),
  });
}

export function reduceConversationAgentEvent(
  state: ConversationRuntimeState,
  event: SequencedConversationAgentEvent,
  stored: StoredConversations,
): ConversationRuntimeState {
  if (event.sequence <= state.sequence) return state;
  let next: ConversationRuntimeState = { ...state, sequence: event.sequence };
  if (!stored.chats[event.conversationId]) return next;

  switch (event.type) {
    case "conversation_context_renewed":
      return setRuntimeMessage(next, event.conversationId, {
        id: `context:${event.createdAt}`,
        type: "time",
        text: event.kind === "compacted" ? "Context summarized · History preserved" : "New topic · History preserved",
        createdAt: event.createdAt,
      });
    case "conversation_model_changed":
      return next;
    case "conversation_status":
      return {
        ...next,
        statuses: { ...next.statuses, [event.conversationId]: event.status },
        activity: event.status === "idle" ? { ...next.activity, [event.conversationId]: undefined } : next.activity,
      };
    case "assistant_message_started": {
      const outgoing = findMessage(next, stored, event.conversationId, event.requestId);
      if (outgoing?.type === "outgoing") {
        next = setRuntimeMessage(next, event.conversationId, {
          ...outgoing,
          id: event.requestId,
          status: "complete",
        });
      }
      return setRuntimeMessage(
        {
          ...next,
          errors: { ...next.errors, [event.conversationId]: undefined },
        },
        event.conversationId,
        {
          id: event.messageId,
          type: "incoming",
          text: "",
          status: "streaming",
          createdAt: event.createdAt,
        },
      );
    }
    case "assistant_text_delta": {
      const current = findMessage(next, stored, event.conversationId, event.messageId);
      return setRuntimeMessage(next, event.conversationId, {
        id: event.messageId,
        type: "incoming",
        text: `${current?.type === "incoming" ? current.text : ""}${event.delta}`,
        status: "streaming",
        ...(current?.createdAt ? { createdAt: current.createdAt } : {}),
      });
    }
    case "assistant_message_completed":
      return finalizeAssistant(next, stored, event.conversationId, event.messageId, "complete");
    case "assistant_message_cancelled":
      return finalizeAssistant(next, stored, event.conversationId, event.messageId, "cancelled");
    case "conversation_error": {
      next = {
        ...next,
        errors: { ...next.errors, [event.conversationId]: event.error },
        activity: { ...next.activity, [event.conversationId]: undefined },
      };
      if (!event.requestId) return next;
      const outgoing = findMessage(next, stored, event.conversationId, event.requestId);
      if (outgoing?.type === "outgoing") {
        next = setRuntimeMessage(next, event.conversationId, {
          ...outgoing,
          id: event.requestId,
          status: "failed",
        });
      }
      const assistantId = event.messageId ?? assistantMessageId(event.requestId);
      const assistant = findMessage(next, stored, event.conversationId, assistantId);
      return setRuntimeMessage(next, event.conversationId, {
        id: assistantId,
        type: "incoming",
        text: assistant?.type === "incoming" && assistant.text ? assistant.text : event.error.message,
        status: "failed",
        retryable: event.error.retryable,
        createdAt: assistant?.createdAt ?? event.createdAt,
      });
    }
    case "tool_activity":
      return {
        ...next,
        activity: {
          ...next.activity,
          [event.conversationId]:
            event.phase === "completed" ? undefined : (event.label ?? toolActivityLabel(event.toolName)),
        },
        toolActivities: {
          ...next.toolActivities,
          [event.conversationId]: upsertToolActivity(next.toolActivities[event.conversationId] ?? [], event),
        },
      };
    case "conversation_notice":
      return {
        ...next,
        activity: {
          ...next.activity,
          [event.conversationId]: noticeLabel(event.kind),
        },
      };
    case "tool_approval_requested":
      return {
        ...next,
        approvals: {
          ...next.approvals,
          [event.conversationId]: [
            ...(next.approvals[event.conversationId] ?? []).filter(
              ({ approvalId }) => approvalId !== event.request.approvalId,
            ),
            event.request,
          ],
        },
      };
    case "tool_approval_resolved":
      return {
        ...next,
        approvals: {
          ...next.approvals,
          [event.conversationId]: (next.approvals[event.conversationId] ?? []).filter(
            ({ approvalId }) => approvalId !== event.approvalId,
          ),
        },
      };
  }
}

export function reconcileConversationRuntime(
  state: ConversationRuntimeState,
  chats: Readonly<Record<string, unknown>>,
  statuses: Record<string, ManagedConversationStatus>,
): ConversationRuntimeState {
  const conversationIds = new Set(Object.keys(chats));
  const retain = <T>(values: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(values).filter(([conversationId]) => conversationIds.has(conversationId)));
  return {
    ...state,
    statuses: Object.fromEntries(
      [...conversationIds].map((conversationId) => [
        conversationId,
        state.statuses[conversationId] ?? statuses[conversationId] ?? "configuration_required",
      ]),
    ),
    messages: retain(state.messages),
    errors: retain(state.errors),
    activity: retain(state.activity),
    toolActivities: retain(state.toolActivities),
    approvals: retain(state.approvals),
  };
}

/**
 * Drops a conversation's transient copies once `stored` holds the same message
 * in the same settled state; from then on the stored copy is authoritative.
 * Queued and streaming copies stay because they are newer than anything stored.
 */
export function pruneSettledRuntimeMessages(
  state: ConversationRuntimeState,
  conversationId: string,
  stored: ReadonlyArray<Message>,
): ConversationRuntimeState {
  const transient = state.messages[conversationId];
  if (!transient?.some(isSettled)) return state;
  const storedById = new Map(stored.flatMap((message) => (message.id ? [[message.id, message]] : [])));
  const kept = transient.filter((message) => {
    const persisted = message.id ? storedById.get(message.id) : undefined;
    return !(persisted && isSettled(message) && isSettled(persisted) && statusOf(persisted) === statusOf(message));
  });
  if (kept.length === transient.length) return state;
  return { ...state, messages: { ...state.messages, [conversationId]: kept } };
}

function statusOf(message: Message): string {
  return message.status ?? "complete";
}

function isSettled(message: Message): boolean {
  return message.status !== "queued" && message.status !== "streaming";
}

export function addPendingRequest(
  pending: Record<string, ReadonlyArray<string>>,
  conversationId: string,
  requestId: string,
): Record<string, ReadonlyArray<string>> {
  const current = pending[conversationId] ?? [];
  if (current.includes(requestId)) return pending;
  return { ...pending, [conversationId]: [...current, requestId] };
}

export function removePendingRequest(
  pending: Record<string, ReadonlyArray<string>>,
  conversationId: string,
  requestId: string,
): Record<string, ReadonlyArray<string>> {
  const current = pending[conversationId];
  if (!current?.includes(requestId)) return pending;
  const remaining = current.filter((candidate) => candidate !== requestId);
  if (remaining.length > 0) return { ...pending, [conversationId]: remaining };
  const { [conversationId]: _removed, ...rest } = pending;
  return rest;
}

export function retainPendingConversations(
  pending: Record<string, ReadonlyArray<string>>,
  chats: Readonly<Record<string, unknown>>,
): Record<string, ReadonlyArray<string>> {
  return Object.fromEntries(Object.entries(pending).filter(([conversationId]) => Boolean(chats[conversationId])));
}

/**
 * A window's messages as they should be shown: transient copies replace the
 * stored ones, and transient messages the window does not hold follow it when
 * it is attached, since they belong at the end of the transcript.
 */
export function overlayRuntimeMessages(
  messages: ReadonlyArray<Message>,
  transient: ReadonlyArray<Message>,
  attached: boolean,
): ReadonlyArray<Message> {
  if (transient.length === 0) return messages;
  const replacements = new Map(transient.flatMap((message) => (message.id ? [[message.id, message]] : [])));
  const held = new Set<string>();
  let changed = false;
  const result = messages.map((message) => {
    const replacement = message.id ? replacements.get(message.id) : undefined;
    if (!replacement?.id) return message;
    held.add(replacement.id);
    changed = true;
    return replacement;
  });
  if (attached) {
    for (const message of transient) {
      if (message.id && held.has(message.id)) continue;
      result.push(message);
      changed = true;
    }
  }
  return changed ? result : messages;
}

export function getRuntimeMessage(
  state: ConversationRuntimeState,
  conversationId: string,
  messageId: string,
): Message | undefined {
  return state.messages[conversationId]?.find(({ id }) => id === messageId);
}

export function removeRuntimeMessage(
  state: ConversationRuntimeState,
  conversationId: string,
  messageId: string,
): ConversationRuntimeState {
  const messages = state.messages[conversationId]?.filter(({ id }) => id !== messageId) ?? [];
  return { ...state, messages: { ...state.messages, [conversationId]: messages } };
}

function finalizeAssistant(
  state: ConversationRuntimeState,
  stored: StoredConversations,
  conversationId: string,
  messageId: string,
  status: "complete" | "cancelled",
): ConversationRuntimeState {
  const current = findMessage(state, stored, conversationId, messageId);
  return setRuntimeMessage(state, conversationId, {
    id: messageId,
    type: "incoming",
    text: current?.type === "incoming" ? current.text : "",
    status,
    ...(current?.createdAt ? { createdAt: current.createdAt } : {}),
  });
}

function setRuntimeMessage(
  state: ConversationRuntimeState,
  conversationId: string,
  message: Message & { id: string },
): ConversationRuntimeState {
  const current = state.messages[conversationId] ?? [];
  const found = current.some(({ id }) => id === message.id);
  return {
    ...state,
    messages: {
      ...state.messages,
      [conversationId]: found
        ? current.map((candidate) => (candidate.id === message.id ? message : candidate))
        : [...current, message],
    },
  };
}

function findMessage(
  state: ConversationRuntimeState,
  stored: StoredConversations,
  conversationId: string,
  messageId: string,
): Message | undefined {
  return (
    getRuntimeMessage(state, conversationId, messageId) ??
    stored.windows[conversationId]?.messages.find(({ id }) => id === messageId)
  );
}

function toolActivityLabel(toolName: string): string {
  return getToolMetadata(toolName)?.activityLabel ?? describeMcpAlias(toolName)?.activityLabel ?? "Running a tool…";
}

function upsertToolActivity(
  activities: ReadonlyArray<ToolActivityView>,
  event: Extract<ConversationAgentEvent, { type: "tool_activity" }>,
): ReadonlyArray<ToolActivityView> {
  const next = activities.some(({ toolCallId }) => toolCallId === event.toolCallId)
    ? activities.map((activity) =>
        activity.toolCallId === event.toolCallId
          ? {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              phase: event.phase,
              ...(event.isError === undefined ? {} : { isError: event.isError }),
            }
          : activity,
      )
    : [
        ...activities,
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: event.phase,
          ...(event.isError === undefined ? {} : { isError: event.isError }),
        },
      ];
  return next.slice(-20);
}

function noticeLabel(
  kind: Extract<ConversationAgentEvent, { type: "conversation_notice" }>["kind"],
): string | undefined {
  if (kind === "retry_started") return "Retrying the request…";
  if (kind === "compaction_started") return "Compacting conversation context…";
  return undefined;
}
