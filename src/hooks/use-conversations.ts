import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackend } from "@/features/backend/backend-provider";
import { expectedRevision } from "@/features/backend/edit-revision";
import { loadPendingAdmissions, removePendingAdmission, savePendingAdmission } from "@/features/drafts/draft-storage";
import { LEGACY_CONVERSATIONS_STORAGE_KEY, MAX_LEGACY_BLOB_BYTES } from "@/features/persistence/storage-policy";
import {
  addPendingRequest,
  type ConversationRuntimeState,
  createConversationRuntime,
  getRuntimeMessage,
  markOutgoingFailed,
  overlayRuntimeMessages,
  reconcileConversationRuntime,
  reduceConversationAgentEvent,
  removePendingRequest,
  removeRuntimeMessage,
  retainPendingConversations,
  stageOutgoingMessage,
  type ToolActivityView,
} from "@/lib/conversation-stream";
import type { BackendError, BackendResult, SequencedConversationAgentEvent, WispApi } from "../../shared/contracts";
import type {
  Chat,
  ChatChanges,
  ChatCollection,
  ConversationStateView,
  ManagedConversationStatus,
  Message,
  TextMessage,
} from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

export const LEGACY_STORAGE_KEY = LEGACY_CONVERSATIONS_STORAGE_KEY;

const EMPTY_STATE: ConversationStateView = {
  initialized: false,
  chats: {},
  statuses: {},
  agentEventSequence: 0,
  pendingToolApprovals: [],
  recoveredCorruptState: false,
};

function legacyChats(storage: Pick<Storage, "getItem">): unknown {
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    if (new TextEncoder().encode(raw).byteLength > MAX_LEGACY_BLOB_BYTES) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const chats = Reflect.get(parsed, "chats");
    return chats && typeof chats === "object" && !Array.isArray(chats) ? chats : {};
  } catch {
    return {};
  }
}

function resultError(result: { ok: false; error: BackendError }): Error {
  return new Error(result.error.message);
}

export async function bootstrapConversationState(
  api: Pick<WispApi, "getConversationState" | "initializeConversations">,
  storage: Pick<Storage, "getItem" | "removeItem">,
  allowLegacyMigration = true,
): Promise<ConversationStateView> {
  const current = await api.getConversationState();
  if (!current.ok) throw resultError(current);
  if (current.value.initialized || !allowLegacyMigration) return current.value;
  const initialized = await api.initializeConversations({ chats: legacyChats(storage) });
  if (!initialized.ok) throw resultError(initialized);
  storage.removeItem(LEGACY_STORAGE_KEY);
  return initialized.value;
}

export interface ConversationsController {
  chats: ChatCollection;
  statuses: Record<string, ManagedConversationStatus>;
  activity: Record<string, string | undefined>;
  conversationErrors: Record<string, BackendError | undefined>;
  acknowledging: Record<string, boolean | undefined>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  toolActivities: Record<string, ReadonlyArray<ToolActivityView>>;
  loading: boolean;
  error: string | null;
  create: (conversation: Chat) => Promise<boolean>;
  update: (conversationId: string, changes: ChatChanges, revision?: number) => Promise<boolean>;
  delete: (conversationId: string, revision?: number) => Promise<boolean>;
  appendMessage: (conversationId: string, message: Message) => Promise<boolean>;
  answerPrompt: (conversationId: string, messageId: string, answer: string) => Promise<boolean>;
  markRead: (conversationId: string) => Promise<boolean>;
  sendMessage: (conversationId: string, text: string) => Promise<boolean>;
  retryMessage: (conversationId: string, requestId: string) => Promise<boolean>;
  abort: (conversationId: string) => Promise<boolean>;
  resolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
}

export function useConversations(): ConversationsController {
  const { api, remote, writable, instanceId } = useBackend();
  const [state, setState] = useState<ConversationStateView>(EMPTY_STATE);
  const [runtime, setRuntime] = useState<ConversationRuntimeState>(() => createConversationRuntime(0, {}));
  const [pendingAcknowledgements, setPendingAcknowledgements] = useState<Record<string, ReadonlyArray<string>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  // Admission can succeed even when both the acknowledgement and status lookup are lost.
  // Keep the original command identity until the server confirms it; retrying must not rerun tools.
  const [initialAdmissions] = useState(() =>
    remote ? loadPendingAdmissions(instanceId) : new Map<string, { conversationId: string; text: string }>(),
  );
  const uncertainAdmissions = useRef(initialAdmissions);
  const forgetAdmission = useCallback(
    (requestId: string) => {
      uncertainAdmissions.current.delete(requestId);
      removePendingAdmission(instanceId, requestId);
    },
    [instanceId],
  );
  const stateRef = useRef(state);
  const runtimeRef = useRef(runtime);
  const readyRef = useRef(false);
  const bufferedEvents = useRef<SequencedConversationAgentEvent[]>([]);
  const processEventRef = useRef<(event: SequencedConversationAgentEvent) => void>(() => undefined);

  const replaceState = useCallback(
    (next: ConversationStateView): void => {
      stateRef.current = next;
      for (const [requestId, request] of uncertainAdmissions.current) {
        if (next.chats[request.conversationId]?.messages.some((message) => message.id === requestId)) {
          forgetAdmission(requestId);
        }
      }
      setState(next);
      const reconciled = reconcileConversationRuntime(runtimeRef.current, next.chats, next.statuses);
      runtimeRef.current = reconciled;
      setRuntime(reconciled);
      setPendingAcknowledgements((current) => retainPendingConversations(current, next.chats));
    },
    [forgetAdmission],
  );

  const replaceRuntime = useCallback((next: ConversationRuntimeState): void => {
    runtimeRef.current = next;
    setRuntime(next);
  }, []);

  const enqueue = useCallback(
    (operation: () => Promise<BackendResult<ConversationStateView>>) => {
      const run = mutationQueue.current.then(async () => {
        try {
          const result = await operation();
          if (!result.ok) throw resultError(result);
          replaceState(result.value);
          setError(null);
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The conversation could not be updated.");
          return false;
        }
      });
      mutationQueue.current = run.then(() => undefined);
      return run;
    },
    [replaceState],
  );

  const reconcileMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      const refreshed = await enqueue(() => api.getConversationState());
      if (!refreshed || !stateRef.current.chats[conversationId]?.messages.some(({ id }) => id === messageId)) return;
      replaceRuntime(removeRuntimeMessage(runtimeRef.current, conversationId, messageId));
    },
    [api, enqueue, replaceRuntime],
  );

  processEventRef.current = (event): void => {
    const next = reduceConversationAgentEvent(runtimeRef.current, event, stateRef.current.chats);
    if (next === runtimeRef.current) return;
    replaceRuntime(next);
    if (!stateRef.current.chats[event.conversationId]) return;
    if (remote) {
      if (
        event.type === "assistant_message_completed" ||
        event.type === "assistant_message_cancelled" ||
        event.type === "conversation_error"
      )
        void enqueue(() => api.getConversationState());
      return;
    }
    if (event.type === "assistant_message_started") {
      const outgoing = getRuntimeMessage(next, event.conversationId, event.requestId);
      if (outgoing) {
        void enqueue(() =>
          api.appendConversationMessage({
            conversationId: event.conversationId,
            message: outgoing,
          }),
        ).then((saved) => {
          if (saved) replaceRuntime(removeRuntimeMessage(runtimeRef.current, event.conversationId, event.requestId));
        });
      }
    } else if (event.type === "assistant_message_completed" || event.type === "assistant_message_cancelled") {
      void reconcileMessage(event.conversationId, event.messageId);
    } else if (event.type === "conversation_error" && event.requestId) {
      const outgoing = getRuntimeMessage(next, event.conversationId, event.requestId);
      if (outgoing) {
        void enqueue(() =>
          api.appendConversationMessage({
            conversationId: event.conversationId,
            message: outgoing,
          }),
        ).then(() => reconcileMessage(event.conversationId, `${event.requestId}:assistant`));
      } else {
        void reconcileMessage(event.conversationId, `${event.requestId}:assistant`);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.subscribeToAgentEvents((event) => {
      if (!readyRef.current) {
        if (bufferedEvents.current.length < 2_048) bufferedEvents.current.push(event);
      } else processEventRef.current(event);
    });
    let lastSnapshot: ConversationStateView | undefined;
    const unsubscribeState = api.subscribeToConversationState?.((next) => {
      if (cancelled) return;
      lastSnapshot = next;
      if (!readyRef.current) return;
      replaceState(next);
      replaceRuntime(createConversationRuntime(next.agentEventSequence, next.statuses, next.pendingToolApprovals));
    });
    void (async () => {
      try {
        const loaded = await bootstrapConversationState(api, window.localStorage, !remote);
        const next = lastSnapshot ?? loaded;
        if (cancelled) return;
        replaceState(next);
        replaceRuntime(createConversationRuntime(next.agentEventSequence, next.statuses, next.pendingToolApprovals));
        readyRef.current = true;
        const pending = bufferedEvents.current
          .filter(({ sequence }) => sequence > next.agentEventSequence)
          .sort((left, right) => left.sequence - right.sequence);
        bufferedEvents.current = [];
        for (const event of pending) processEventRef.current(event);
        setError(
          next.recoveredCorruptState
            ? "Conversation storage was corrupt. The original file was preserved and a fresh store was created."
            : null,
        );
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load conversations.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      readyRef.current = false;
      unsubscribe();
      unsubscribeState?.();
    };
  }, [api, remote, replaceRuntime, replaceState]);

  const submitMessage = useCallback(
    async (conversationId: string, textValue: string, requestId: string): Promise<boolean> => {
      const text = textValue.trim();
      if (!writable || !text || stateRef.current.chats[conversationId]?.kind !== "wisp") return false;
      const status = runtimeRef.current.statuses[conversationId];
      if (status !== "idle" && status !== "working") return false;
      if (remote) {
        if (!savePendingAdmission(instanceId, requestId, { conversationId, text })) {
          setError("Could not preserve this request on your device. Enable device storage before sending.");
          return false;
        }
        uncertainAdmissions.current.set(requestId, { conversationId, text });
      }
      const message: TextMessage & { id: string } = {
        id: requestId,
        type: "outgoing",
        text,
        createdAt: new Date().toISOString(),
        status: "queued",
      };
      replaceRuntime(stageOutgoingMessage(runtimeRef.current, conversationId, message));
      setPendingAcknowledgements((current) => addPendingRequest(current, conversationId, requestId));
      if (!remote) {
        const persisted = await enqueue(() => api.appendConversationMessage({ conversationId, message }));
        if (!persisted) {
          setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, requestId));
          return false;
        }
        replaceRuntime(removeRuntimeMessage(runtimeRef.current, conversationId, requestId));
      }
      const result = await api.sendMessage({ conversationId, requestId, text }).catch(
        (): BackendResult<never> => ({
          ok: false,
          error: {
            code: "transport_unavailable",
            message: "The server acknowledgement was lost. Retry to check this same request.",
            retryable: true,
          },
        }),
      );
      setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, requestId));
      const admissionVisible =
        remote && stateRef.current.chats[conversationId]?.messages.some((item) => item.id === requestId);
      if (result.ok || admissionVisible) {
        forgetAdmission(requestId);
        if (remote) {
          await enqueue(() => api.getConversationState());
          replaceRuntime(
            removeRuntimeMessage(
              removeRuntimeMessage(runtimeRef.current, conversationId, requestId),
              conversationId,
              `${requestId}:assistant`,
            ),
          );
        }
        return true;
      }
      if (remote && result.error.code === "transport_unavailable") {
        uncertainAdmissions.current.set(requestId, { conversationId, text });
      } else {
        forgetAdmission(requestId);
      }
      const failed = markOutgoingFailed(
        runtimeRef.current,
        stateRef.current.chats,
        conversationId,
        requestId,
        result.error,
      );
      replaceRuntime(failed);
      const outgoing = getRuntimeMessage(failed, conversationId, requestId);
      if (outgoing && !remote) void enqueue(() => api.appendConversationMessage({ conversationId, message: outgoing }));
      return false;
    },
    [api, remote, writable, instanceId, forgetAdmission, enqueue, replaceRuntime],
  );

  const sendMessage = useCallback(
    (conversationId: string, textValue: string): Promise<boolean> => {
      const text = textValue.trim();
      const uncertain = remote
        ? [...uncertainAdmissions.current].find(
            ([, request]) => request.conversationId === conversationId && request.text === text,
          )
        : undefined;
      return submitMessage(conversationId, text, uncertain?.[0] ?? crypto.randomUUID());
    },
    [remote, submitMessage],
  );

  const retryMessage = useCallback(
    (conversationId: string, requestId: string): Promise<boolean> => {
      if (remote) {
        const uncertain = uncertainAdmissions.current.get(requestId);
        if (uncertain?.conversationId === conversationId)
          return submitMessage(conversationId, uncertain.text, requestId);
        setError("This request is already recorded by the server. Send a new message to run it again.");
        return Promise.resolve(false);
      }
      const chats = overlayRuntimeMessages(stateRef.current.chats, runtimeRef.current.messages);
      const original = chats[conversationId]?.messages.find(({ id }) => id === requestId);
      return original?.type === "outgoing" ? sendMessage(conversationId, original.text) : Promise.resolve(false);
    },
    [remote, sendMessage, submitMessage],
  );

  const abort = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const result = await api.abortConversation({ conversationId });
      if (result.ok) return true;
      setError(result.error.message);
      return false;
    },
    [api],
  );

  const resolveApproval = useCallback(
    async (request: ToolApprovalRequest, decision: ToolApprovalDecision): Promise<boolean> => {
      const result = await api.resolveToolApproval({
        approvalId: request.approvalId,
        conversationId: request.conversationId,
        toolCallId: request.toolCallId,
        decision,
      });
      if (result.ok) return true;
      setError(result.error.message);
      return false;
    },
    [api],
  );

  const chats = useMemo(() => overlayRuntimeMessages(state.chats, runtime.messages), [runtime.messages, state.chats]);
  const acknowledging = useMemo(
    () =>
      Object.fromEntries(Object.entries(pendingAcknowledgements).map(([id, requests]) => [id, requests.length > 0])),
    [pendingAcknowledgements],
  );

  return {
    chats,
    statuses: runtime.statuses,
    activity: runtime.activity,
    conversationErrors: runtime.errors,
    acknowledging,
    approvals: runtime.approvals,
    toolActivities: runtime.toolActivities,
    loading,
    error,
    create: useCallback((conversation) => enqueue(() => api.createConversation({ conversation })), [api, enqueue]),
    update: useCallback(
      (conversationId, changes, revision) =>
        enqueue(() => api.updateConversation({ conversationId, changes, ...expectedRevision(revision) })),
      [api, enqueue],
    ),
    delete: useCallback(
      (conversationId, revision) =>
        enqueue(() => api.deleteConversation({ conversationId, ...expectedRevision(revision) })),
      [api, enqueue],
    ),
    appendMessage: useCallback(
      (conversationId, message) => enqueue(() => api.appendConversationMessage({ conversationId, message })),
      [api, enqueue],
    ),
    answerPrompt: useCallback(
      (conversationId, messageId, answer) =>
        enqueue(() => api.answerConversationPrompt({ conversationId, messageId, answer })),
      [api, enqueue],
    ),
    markRead: useCallback(
      (conversationId) => enqueue(() => api.markConversationRead({ conversationId })),
      [api, enqueue],
    ),
    sendMessage,
    retryMessage,
    abort,
    resolveApproval,
  };
}
