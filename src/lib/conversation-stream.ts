import type { BackendError, ConversationAgentEvent, SequencedConversationAgentEvent } from "../../shared/contracts";
import {
  MAX_MESSAGE_STEPS,
  assistantMessageId,
  replyPartAfterWork,
  messageFailure,
  type ManagedConversationStatus,
  type Message,
} from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";
import { describeMcpAlias, getToolMetadata } from "../../shared/tool-catalog";

export interface ConversationRuntimeState {
  sequence: number;
  statuses: Record<string, ManagedConversationStatus>;
  messages: Record<string, ReadonlyArray<Message>>;
  errors: Record<string, BackendError | undefined>;
  activity: Record<string, string | undefined>;
  /** In a circle, the members whose turns are running (ADR 042). */
  turns: Record<string, ReadonlyArray<string> | undefined>;
  /** The members the decision model chose, among each circle's running turns. */
  chosen: Record<string, ReadonlyArray<string> | undefined>;
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
    messages: Object.fromEntries(
      Object.entries(liveMessages).map(([conversationId, messages]) => [conversationId, stepsBeforeReplies(messages)]),
    ),
    errors: {},
    activity: {},
    turns: {},
    chosen: {},
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

export function reduceConversationAgentEvent(
  state: ConversationRuntimeState,
  event: SequencedConversationAgentEvent,
  stored: StoredConversations,
): ConversationRuntimeState {
  if (event.sequence <= state.sequence) return state;
  let next: ConversationRuntimeState = { ...state, sequence: event.sequence };
  if (!stored.chats[event.conversationId]) return next;
  next = settleWork(next, event);

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
        turns: event.status === "working" ? next.turns : { ...next.turns, [event.conversationId]: undefined },
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
          ...authorOf(event),
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
        ...authorOf(event),
        ...(event.wispId && next.chosen[event.conversationId]?.includes(event.wispId)
          ? { chosenAutomatically: true as const }
          : {}),
      });
    }
    case "assistant_message_completed":
      return finalizeAssistant(
        next,
        stored,
        event.conversationId,
        event.messageId,
        "complete",
        event.fallbackModel,
        event.wispId,
      );
    case "assistant_message_cancelled":
      return finalizeAssistant(
        next,
        stored,
        event.conversationId,
        event.messageId,
        "cancelled",
        undefined,
        event.wispId,
      );
    case "circle_turn_started":
      return {
        ...next,
        turns: {
          ...next.turns,
          [event.conversationId]: [...without(next.turns[event.conversationId], event.wispId), event.wispId],
        },
        chosen: {
          ...next.chosen,
          [event.conversationId]: [
            ...without(next.chosen[event.conversationId], event.wispId),
            ...(event.chosenAutomatically ? [event.wispId] : []),
          ],
        },
        activity: { ...next.activity, [event.conversationId]: undefined },
      };
    case "circle_turn_ended":
      return {
        ...next,
        turns: { ...next.turns, [event.conversationId]: without(next.turns[event.conversationId], event.wispId) },
        activity: { ...next.activity, [event.conversationId]: undefined },
      };
    case "conversation_error": {
      // In a circle, a member failing fails only its reply; the message was sent, and others answer it (ADR 011).
      if (event.wispId && event.requestId) {
        const outgoing = findMessage(next, stored, event.conversationId, event.requestId);
        if (outgoing?.type === "outgoing" && outgoing.status !== "complete") {
          next = setRuntimeMessage(next, event.conversationId, {
            ...outgoing,
            id: event.requestId,
            status: "complete",
          });
        }
        const replyId = event.messageId ?? assistantMessageId(event.requestId);
        const reply = findMessage(next, stored, event.conversationId, replyId);
        return setRuntimeMessage(next, event.conversationId, {
          id: replyId,
          type: "incoming",
          text: reply?.type === "incoming" ? reply.text : "",
          status: "failed",
          error: messageFailure(event.error),
          retryable: false,
          createdAt: reply?.createdAt ?? event.createdAt,
          authorId: event.wispId,
        });
      }
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
        text: assistant?.type === "incoming" ? assistant.text : "",
        status: "failed",
        error: messageFailure(event.error),
        retryable: event.error.retryable,
        createdAt: assistant?.createdAt ?? event.createdAt,
      });
    }
    case "turn_item":
      return {
        ...next,
        activity: {
          ...next.activity,
          [event.conversationId]:
            event.item.status === "running" ? (event.item.label ?? toolActivityLabel(event.item.toolName)) : undefined,
        },
        messages: {
          ...next.messages,
          [event.conversationId]: upsertWork(next.messages[event.conversationId] ?? [], stored, event),
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
    case "follow_up_taken":
    case "job_message_delivered":
      // The message itself arrives with the conversation's changes.
      return next;
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
    turns: retain(state.turns),
    chosen: retain(state.chosen),
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

function finalizeAssistant(
  state: ConversationRuntimeState,
  stored: StoredConversations,
  conversationId: string,
  messageId: string,
  status: "complete" | "cancelled",
  fallbackModel?: string,
  wispId?: string,
): ConversationRuntimeState {
  const current = findMessage(state, stored, conversationId, messageId);
  return setRuntimeMessage(state, conversationId, {
    id: messageId,
    type: "incoming",
    text: current?.type === "incoming" ? current.text : "",
    status,
    ...(current?.createdAt ? { createdAt: current.createdAt } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(current?.type === "incoming" && current.chosenAutomatically ? { chosenAutomatically: true as const } : {}),
    ...authorOf({ wispId }),
  });
}

function without(list: ReadonlyArray<string> | undefined, value: string): ReadonlyArray<string> {
  return (list ?? []).filter((item) => item !== value);
}

/** A circle's reply names its member; in a Wisp's own conversation it is the Wisp's. */
function authorOf(event: { wispId?: string }): { authorId?: string } {
  return event.wispId ? { authorId: event.wispId } : {};
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

/**
 * Adds a step to its group's message, or updates it. A new group goes right
 * before the reply part that follows it, which started before its steps did.
 */
function upsertWork(
  messages: ReadonlyArray<Message>,
  stored: StoredConversations,
  event: Extract<ConversationAgentEvent, { type: "turn_item" }>,
): ReadonlyArray<Message> {
  const current =
    messages.find(({ id }) => id === event.groupId) ??
    stored.windows[event.conversationId]?.messages.find(({ id }) => id === event.groupId);
  const steps = current?.type === "incoming" ? (current.steps ?? []) : [];
  const updated = steps.some(({ id }) => id === event.item.id)
    ? steps.map((step) => (step.id === event.item.id ? event.item : step))
    : [...steps, event.item];
  const message: Message & { id: string } = {
    id: event.groupId,
    type: "incoming",
    text: "",
    // Stored once the reply writes on; until then it is live.
    status: current?.status === "complete" ? "complete" : "streaming",
    steps: updated.slice(-MAX_MESSAGE_STEPS),
    createdAt: current?.createdAt ?? event.item.startedAt,
    ...authorOf(event),
  };
  if (messages.some(({ id }) => id === event.groupId)) {
    return messages.map((candidate) => (candidate.id === event.groupId ? message : candidate));
  }
  const after = messages.findIndex(({ id }) => id === replyPartAfterWork(event.groupId));
  return after === -1 ? [...messages, message] : [...messages.slice(0, after), message, ...messages.slice(after)];
}

/** Puts each group of steps before the reply part after it, as `upsertWork` does. */
function stepsBeforeReplies(messages: ReadonlyArray<Message>): ReadonlyArray<Message> {
  let ordered = messages;
  for (const message of messages) {
    const reply = message.id ? replyPartAfterWork(message.id) : null;
    if (!reply) continue;
    const at = ordered.indexOf(message);
    const before = ordered.findIndex(({ id }) => id === reply);
    if (before === -1 || before > at) continue;
    const rest = ordered.filter((candidate) => candidate !== message);
    ordered = [...rest.slice(0, before), message, ...rest.slice(before)];
  }
  return ordered;
}

/**
 * Settles the live groups of steps the backend stores on this event, as it
 * stores them: when their reply writes on, ends, or fails, and when the
 * conversation stops working. The stored copies then replace them.
 */
function settleWork(state: ConversationRuntimeState, event: ConversationAgentEvent): ConversationRuntimeState {
  let requestId: string | undefined;
  switch (event.type) {
    case "assistant_text_delta":
    case "assistant_message_completed":
    case "assistant_message_cancelled":
    case "follow_up_taken":
      requestId = event.requestId;
      break;
    case "conversation_error":
      if (!event.requestId) return state;
      requestId = event.requestId;
      break;
    case "conversation_status":
      if (event.status === "working") return state;
      break;
    default:
      return state;
  }
  const messages = state.messages[event.conversationId];
  const settles = (message: Message) =>
    message.type === "incoming" &&
    message.status === "streaming" &&
    Boolean(message.steps?.length) &&
    !message.text &&
    (requestId === undefined || message.id?.startsWith(`${requestId}:work`));
  if (!messages?.some(settles)) return state;
  return {
    ...state,
    messages: {
      ...state.messages,
      [event.conversationId]: messages.map((message) =>
        settles(message) ? { ...message, status: "complete" } : message,
      ),
    },
  };
}

function noticeLabel(
  kind: Extract<ConversationAgentEvent, { type: "conversation_notice" }>["kind"],
): string | undefined {
  if (kind === "retry_started") return "Retrying the request…";
  if (kind === "compaction_started") return "Compacting conversation context…";
  if (kind === "fallback_started") return "The model failed. Answering with the fallback model…";
  return undefined;
}
