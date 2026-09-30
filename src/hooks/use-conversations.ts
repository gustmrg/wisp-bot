import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BackendError,
  BackendResult,
  ModelSelection,
  SequencedConversationAgentEvent,
  WispApi,
} from "../../shared/contracts";
import type {
  Chat,
  ChatChanges,
  ChatCollection,
  ConversationStateView,
  ManagedConversationStatus,
  OutgoingMessage,
} from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { LEGACY_CONVERSATIONS_STORAGE_KEY, MAX_LEGACY_BLOB_BYTES } from "@/features/persistence/storage-policy";
import {
  createConversationRuntime,
  addPendingRequest,
  getRuntimeMessage,
  markOutgoingFailed,
  overlayRuntimeMessages,
  pruneSettledRuntimeMessages,
  reduceConversationAgentEvent,
  reconcileConversationRuntime,
  removeRuntimeMessage,
  removePendingRequest,
  retainPendingConversations,
  stageOutgoingMessage,
  type ConversationRuntimeState,
  type ToolActivityView,
} from "@/lib/conversation-stream";

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
): Promise<ConversationStateView> {
  const current = await api.getConversationState();
  if (!current.ok) throw resultError(current);
  if (current.value.initialized) return current.value;
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
  create: (conversation: Chat, model?: ModelSelection | null) => Promise<boolean>;
  update: (conversationId: string, changes: ChatChanges) => Promise<boolean>;
  delete: (conversationId: string) => Promise<boolean>;
  appendMessage: (conversationId: string, message: OutgoingMessage) => Promise<boolean>;
  answerPrompt: (conversationId: string, messageId: string, answer: string) => Promise<boolean>;
  markRead: (conversationId: string) => Promise<boolean>;
  sendMessage: (conversationId: string, text: string) => Promise<boolean>;
  retryMessage: (conversationId: string, requestId: string) => Promise<boolean>;
  abort: (conversationId: string) => Promise<boolean>;
  resolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
}

export function useConversations(): ConversationsController {
  const [state, setState] = useState<ConversationStateView>(EMPTY_STATE);
  const [runtime, setRuntime] = useState<ConversationRuntimeState>(() => createConversationRuntime(0, {}));
  const [pendingAcknowledgements, setPendingAcknowledgements] = useState<Record<string, ReadonlyArray<string>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const stateRef = useRef(state);
  const runtimeRef = useRef(runtime);
  const readyRef = useRef(false);
  const bufferedEvents = useRef<SequencedConversationAgentEvent[]>([]);
  const processEventRef = useRef<(event: SequencedConversationAgentEvent) => void>(() => undefined);

  const replaceState = useCallback((next: ConversationStateView): void => {
    stateRef.current = next;
    setState(next);
    const reconciled = pruneSettledRuntimeMessages(
      reconcileConversationRuntime(runtimeRef.current, next.chats, next.statuses),
      next.chats,
    );
    runtimeRef.current = reconciled;
    setRuntime(reconciled);
    setPendingAcknowledgements((current) => retainPendingConversations(current, next.chats));
  }, []);

  const replaceRuntime = useCallback((next: ConversationRuntimeState): void => {
    runtimeRef.current = next;
    setRuntime(next);
  }, []);

  // Merges one stored chat, from a single-chat response or a backend push. A
  // chat deleted in the meantime stays deleted.
  const applyChat = useCallback(
    (chat: Chat): void => {
      if (!stateRef.current.chats[chat.id]) return;
      replaceState({ ...stateRef.current, chats: { ...stateRef.current.chats, [chat.id]: chat } });
    },
    [replaceState],
  );

  const enqueueMutation = useCallback(
    <T>(operation: () => Promise<BackendResult<T>>, apply: (value: T) => void): Promise<boolean> => {
      const run = mutationQueue.current.then(async () => {
        try {
          const result = await operation();
          if (!result.ok) throw resultError(result);
          apply(result.value);
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
    [],
  );

  const enqueue = useCallback(
    (operation: () => Promise<BackendResult<ConversationStateView>>) => enqueueMutation(operation, replaceState),
    [enqueueMutation, replaceState],
  );

  const enqueueChat = useCallback(
    (operation: () => Promise<BackendResult<Chat>>) => enqueueMutation(operation, applyChat),
    [applyChat, enqueueMutation],
  );

  // Events only drive the transient runtime view. The backend persists what they
  // imply (reply text, delivery status) and pushes the stored chat afterwards.
  processEventRef.current = (event): void => {
    const next = reduceConversationAgentEvent(runtimeRef.current, event, stateRef.current.chats);
    if (next !== runtimeRef.current) replaceRuntime(next);
  };

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.wisp.subscribeToAgentEvents((event) => {
      if (!readyRef.current) bufferedEvents.current.push(event);
      else processEventRef.current(event);
    });
    const unsubscribeChanges = window.wisp.subscribeToConversationChanges((chat) => {
      // Backend messages arrive in send order, so a push received before the
      // bootstrap snapshot is already reflected in that snapshot.
      if (readyRef.current) applyChat(chat);
    });
    void (async () => {
      try {
        const next = await bootstrapConversationState(window.wisp, window.localStorage);
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
      unsubscribeChanges();
    };
  }, [applyChat, replaceRuntime, replaceState]);

  const sendMessage = useCallback(
    async (conversationId: string, textValue: string): Promise<boolean> => {
      const text = textValue.trim();
      if (!text || stateRef.current.chats[conversationId]?.kind !== "wisp") return false;
      const status = runtimeRef.current.statuses[conversationId];
      if (status !== "idle" && status !== "working") return false;
      const requestId = crypto.randomUUID();
      const message: OutgoingMessage & { id: string } = {
        id: requestId,
        type: "outgoing",
        text,
        createdAt: new Date().toISOString(),
        status: "queued",
      };
      replaceRuntime(stageOutgoingMessage(runtimeRef.current, conversationId, message));
      setPendingAcknowledgements((current) => addPendingRequest(current, conversationId, requestId));
      const persisted = await enqueueChat(() => window.wisp.appendConversationMessage({ conversationId, message }));
      if (!persisted) {
        setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, requestId));
        return false;
      }
      replaceRuntime(removeRuntimeMessage(runtimeRef.current, conversationId, requestId));
      const result = await window.wisp.sendMessage({ conversationId, requestId, text });
      setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, requestId));
      if (result.ok) return true;
      const failed = markOutgoingFailed(
        runtimeRef.current,
        stateRef.current.chats,
        conversationId,
        requestId,
        result.error,
      );
      replaceRuntime(failed);
      const outgoing = getRuntimeMessage(failed, conversationId, requestId);
      if (outgoing?.type === "outgoing") {
        const message: OutgoingMessage = { ...outgoing, type: "outgoing" };
        void enqueueChat(() => window.wisp.appendConversationMessage({ conversationId, message }));
      }
      return false;
    },
    [enqueueChat, replaceRuntime],
  );

  const retryMessage = useCallback(
    (conversationId: string, requestId: string): Promise<boolean> => {
      const chats = overlayRuntimeMessages(stateRef.current.chats, runtimeRef.current.messages);
      const original = chats[conversationId]?.messages.find(({ id }) => id === requestId);
      return original?.type === "outgoing" ? sendMessage(conversationId, original.text) : Promise.resolve(false);
    },
    [sendMessage],
  );

  const abort = useCallback(async (conversationId: string): Promise<boolean> => {
    const result = await window.wisp.abortConversation({ conversationId });
    if (result.ok) return true;
    setError(result.error.message);
    return false;
  }, []);

  const resolveApproval = useCallback(
    async (request: ToolApprovalRequest, decision: ToolApprovalDecision): Promise<boolean> => {
      const result = await window.wisp.resolveToolApproval({
        approvalId: request.approvalId,
        conversationId: request.conversationId,
        toolCallId: request.toolCallId,
        decision,
      });
      if (result.ok) return true;
      setError(result.error.message);
      return false;
    },
    [],
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
    create: useCallback(
      (conversation: Chat, model?: ModelSelection | null) =>
        enqueue(() => window.wisp.createConversation({ conversation, model: model ?? null })),
      [enqueue],
    ),
    update: useCallback(
      (conversationId, changes) => enqueue(() => window.wisp.updateConversation({ conversationId, changes })),
      [enqueue],
    ),
    delete: useCallback(
      (conversationId) => enqueue(() => window.wisp.deleteConversation({ conversationId })),
      [enqueue],
    ),
    appendMessage: useCallback(
      (conversationId, message) =>
        enqueueChat(() => window.wisp.appendConversationMessage({ conversationId, message })),
      [enqueueChat],
    ),
    answerPrompt: useCallback(
      (conversationId, messageId, answer) =>
        enqueueChat(() => window.wisp.answerConversationPrompt({ conversationId, messageId, answer })),
      [enqueueChat],
    ),
    markRead: useCallback(
      (conversationId) => enqueueChat(() => window.wisp.markConversationRead({ conversationId })),
      [enqueueChat],
    ),
    sendMessage,
    retryMessage,
    abort,
    resolveApproval,
  };
}
