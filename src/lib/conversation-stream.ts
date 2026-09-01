import type { BackendError, ConversationAgentEvent, SequencedConversationAgentEvent } from "../../shared/contracts";
import type {
  ChatCollection,
  ManagedConversationStatus,
  Message,
  TextMessage,
} from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

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

export function createConversationRuntime(
  sequence: number,
  statuses: Record<string, ManagedConversationStatus>,
  pendingApprovals: ReadonlyArray<ToolApprovalRequest> = [],
): ConversationRuntimeState {
  return {
    sequence,
    statuses,
    messages: {},
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
  return setRuntimeMessage({
    ...state,
    errors: { ...state.errors, [conversationId]: undefined },
  }, conversationId, { ...message, status: "queued" });
}

export function markOutgoingFailed(
  state: ConversationRuntimeState,
  chats: ChatCollection,
  conversationId: string,
  requestId: string,
  error: BackendError,
): ConversationRuntimeState {
  let next = {
    ...state,
    errors: { ...state.errors, [conversationId]: error },
  };
  const outgoing = findMessage(next, chats, conversationId, requestId);
  if (outgoing?.type === "outgoing") {
    next = setRuntimeMessage(next, conversationId, { ...outgoing, id: requestId, status: "failed" });
  }
  return setRuntimeMessage(next, conversationId, {
    id: `${requestId}:assistant`,
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
  chats: ChatCollection,
): ConversationRuntimeState {
  if (event.sequence <= state.sequence) return state;
  let next: ConversationRuntimeState = { ...state, sequence: event.sequence };

  switch (event.type) {
    case "conversation_status":
      return {
        ...next,
        statuses: { ...next.statuses, [event.conversationId]: event.status },
        activity: event.status === "idle"
          ? { ...next.activity, [event.conversationId]: undefined }
          : next.activity,
      };
    case "assistant_message_started": {
      const outgoing = findMessage(next, chats, event.conversationId, event.requestId);
      if (outgoing?.type === "outgoing") {
        next = setRuntimeMessage(next, event.conversationId, {
          ...outgoing,
          id: event.requestId,
          status: "complete",
        });
      }
      return setRuntimeMessage({
        ...next,
        errors: { ...next.errors, [event.conversationId]: undefined },
      }, event.conversationId, {
        id: event.messageId,
        type: "incoming",
        text: "",
        status: "streaming",
        createdAt: event.createdAt,
      });
    }
    case "assistant_text_delta": {
      const current = findMessage(next, chats, event.conversationId, event.messageId);
      return setRuntimeMessage(next, event.conversationId, {
        id: event.messageId,
        type: "incoming",
        text: `${current?.type === "incoming" ? current.text : ""}${event.delta}`,
        status: "streaming",
        ...(current?.createdAt ? { createdAt: current.createdAt } : {}),
      });
    }
    case "assistant_message_completed":
      return finalizeAssistant(next, chats, event.conversationId, event.messageId, "complete");
    case "assistant_message_cancelled":
      return finalizeAssistant(next, chats, event.conversationId, event.messageId, "cancelled");
    case "conversation_error": {
      next = {
        ...next,
        errors: { ...next.errors, [event.conversationId]: event.error },
        activity: { ...next.activity, [event.conversationId]: undefined },
      };
      if (!event.requestId) return next;
      const outgoing = findMessage(next, chats, event.conversationId, event.requestId);
      if (outgoing?.type === "outgoing") {
        next = setRuntimeMessage(next, event.conversationId, {
          ...outgoing,
          id: event.requestId,
          status: "failed",
        });
      }
      const assistantId = `${event.requestId}:assistant`;
      const assistant = findMessage(next, chats, event.conversationId, assistantId);
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
          [event.conversationId]: event.phase === "completed"
            ? undefined
            : toolActivityLabel(event.toolName),
        },
        toolActivities: {
          ...next.toolActivities,
          [event.conversationId]: upsertToolActivity(
            next.toolActivities[event.conversationId] ?? [],
            event,
          ),
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
            ...(next.approvals[event.conversationId] ?? []).filter(({ approvalId }) => (
              approvalId !== event.request.approvalId
            )),
            event.request,
          ],
        },
      };
    case "tool_approval_resolved":
      return {
        ...next,
        approvals: {
          ...next.approvals,
          [event.conversationId]: (next.approvals[event.conversationId] ?? []).filter(({ approvalId }) => (
            approvalId !== event.approvalId
          )),
        },
      };
  }
}

export function overlayRuntimeMessages(
  chats: ChatCollection,
  runtimeMessages: ConversationRuntimeState["messages"],
): ChatCollection {
  let changed = false;
  const result: ChatCollection = { ...chats };
  for (const [conversationId, transient] of Object.entries(runtimeMessages)) {
    const chat = chats[conversationId];
    if (!chat || transient.length === 0) continue;
    const replacements = new Map(transient.flatMap((message) => message.id ? [[message.id, message]] : []));
    const existingIds = new Set(chat.messages.flatMap((message) => message.id ? [message.id] : []));
    const messages = chat.messages.map((message) => (
      message.id && replacements.has(message.id) ? replacements.get(message.id)! : message
    ));
    for (const message of transient) {
      if (!message.id || !existingIds.has(message.id)) messages.push(message);
    }
    result[conversationId] = { ...chat, messages };
    changed = true;
  }
  return changed ? result : chats;
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
  chats: ChatCollection,
  conversationId: string,
  messageId: string,
  status: "complete" | "cancelled",
): ConversationRuntimeState {
  const current = findMessage(state, chats, conversationId, messageId);
  return setRuntimeMessage(state, conversationId, {
    id: messageId,
    type: "incoming",
    text: current?.type === "incoming" && current.text
      ? current.text
      : status === "cancelled" ? "Stopped." : "",
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
        ? current.map((candidate) => candidate.id === message.id ? message : candidate)
        : [...current, message],
    },
  };
}

function findMessage(
  state: ConversationRuntimeState,
  chats: ChatCollection,
  conversationId: string,
  messageId: string,
): Message | undefined {
  return getRuntimeMessage(state, conversationId, messageId)
    ?? chats[conversationId]?.messages.find(({ id }) => id === messageId);
}

function toolActivityLabel(toolName: string): string {
  if (toolName === "read") return "Reading files…";
  if (toolName === "grep" || toolName === "find") return "Searching the workspace…";
  if (toolName === "edit") return "Editing a file…";
  if (toolName === "write") return "Writing a file…";
  return "Inspecting the workspace…";
}

function upsertToolActivity(
  activities: ReadonlyArray<ToolActivityView>,
  event: Extract<ConversationAgentEvent, { type: "tool_activity" }>,
): ReadonlyArray<ToolActivityView> {
  const next = activities.some(({ toolCallId }) => toolCallId === event.toolCallId)
    ? activities.map((activity) => activity.toolCallId === event.toolCallId
      ? {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: event.phase,
          ...(event.isError === undefined ? {} : { isError: event.isError }),
        }
      : activity)
    : [...activities, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        phase: event.phase,
        ...(event.isError === undefined ? {} : { isError: event.isError }),
      }];
  return next.slice(-20);
}

function noticeLabel(
  kind: Extract<ConversationAgentEvent, { type: "conversation_notice" }>["kind"],
): string | undefined {
  if (kind === "retry_started") return "Retrying the request…";
  if (kind === "compaction_started") return "Compacting conversation context…";
  return undefined;
}
