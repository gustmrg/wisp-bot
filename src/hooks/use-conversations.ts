import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BackendError, BackendResult, SequencedConversationAgentEvent, WispApi } from "../../shared/contracts";
import type {
  AgentSettings, Chat, ChatCollection, ConversationStateView, ManagedConversationStatus, Message, TextMessage,
} from "../../shared/conversations";
import { initialChats } from "@/chat-data";
import { migrateLegacyChats } from "@/lib/circle-members";
import {
  createConversationRuntime, getRuntimeMessage, markOutgoingFailed, overlayRuntimeMessages,
  reduceConversationAgentEvent, removeRuntimeMessage, stageOutgoingMessage,
  type ConversationRuntimeState,
} from "@/lib/conversation-stream";

export const LEGACY_STORAGE_KEY = "wisp-bot-ui-v3";

const EMPTY_STATE: ConversationStateView = {
  initialized: false,
  chats: {},
  statuses: {},
  agentEventSequence: 0,
  recoveredCorruptState: false,
};

function legacyChats(storage: Pick<Storage, "getItem">): ChatCollection {
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return initialChats;
    const parsed = JSON.parse(raw) as { chats?: ChatCollection };
    return parsed.chats && Object.keys(parsed.chats).length > 0
      ? migrateLegacyChats(parsed.chats)
      : initialChats;
  } catch {
    return initialChats;
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
  loading: boolean;
  error: string | null;
  create: (conversation: Chat) => Promise<boolean>;
  update: (conversationId: string, changes: Partial<Omit<AgentSettings, "id" | "isCircle">>) => Promise<boolean>;
  delete: (conversationId: string) => Promise<boolean>;
  appendMessage: (conversationId: string, message: Message) => Promise<boolean>;
  answerPrompt: (conversationId: string, messageId: string, answer: string) => Promise<boolean>;
  markRead: (conversationId: string) => Promise<boolean>;
  sendMessage: (conversationId: string, text: string) => Promise<boolean>;
  retryMessage: (conversationId: string, requestId: string) => Promise<boolean>;
  abort: (conversationId: string) => Promise<boolean>;
}

export function useConversations(): ConversationsController {
  const [state, setState] = useState<ConversationStateView>(EMPTY_STATE);
  const [runtime, setRuntime] = useState<ConversationRuntimeState>(() => createConversationRuntime(0, {}));
  const [acknowledging, setAcknowledging] = useState<Record<string, boolean | undefined>>({});
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
  }, []);

  const replaceRuntime = useCallback((next: ConversationRuntimeState): void => {
    runtimeRef.current = next;
    setRuntime(next);
  }, []);

  const enqueue = useCallback((operation: () => Promise<BackendResult<ConversationStateView>>) => {
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
  }, [replaceState]);

  const reconcileMessage = useCallback(async (conversationId: string, messageId: string): Promise<void> => {
    const refreshed = await enqueue(() => window.wisp.getConversationState());
    if (!refreshed || !stateRef.current.chats[conversationId]?.messages.some(({ id }) => id === messageId)) return;
    replaceRuntime(removeRuntimeMessage(runtimeRef.current, conversationId, messageId));
  }, [enqueue, replaceRuntime]);

  processEventRef.current = (event): void => {
    const next = reduceConversationAgentEvent(runtimeRef.current, event, stateRef.current.chats);
    if (next === runtimeRef.current) return;
    replaceRuntime(next);
    if (event.type === "assistant_message_started") {
      const outgoing = getRuntimeMessage(next, event.conversationId, event.requestId);
      if (outgoing) {
        void enqueue(() => window.wisp.appendConversationMessage({
          conversationId: event.conversationId,
          message: outgoing,
        })).then((saved) => {
          if (saved) replaceRuntime(removeRuntimeMessage(runtimeRef.current, event.conversationId, event.requestId));
        });
      }
    } else if (event.type === "assistant_message_completed" || event.type === "assistant_message_cancelled") {
      void reconcileMessage(event.conversationId, event.messageId);
    } else if (event.type === "conversation_error" && event.requestId) {
      const outgoing = getRuntimeMessage(next, event.conversationId, event.requestId);
      if (outgoing) {
        void enqueue(() => window.wisp.appendConversationMessage({
          conversationId: event.conversationId,
          message: outgoing,
        })).then(() => reconcileMessage(event.conversationId, `${event.requestId}:assistant`));
      } else {
        void reconcileMessage(event.conversationId, `${event.requestId}:assistant`);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.wisp.subscribeToAgentEvents((event) => {
      if (!readyRef.current) bufferedEvents.current.push(event);
      else processEventRef.current(event);
    });
    void (async () => {
      try {
        const next = await bootstrapConversationState(window.wisp, window.localStorage);
        if (cancelled) return;
        replaceState(next);
        replaceRuntime(createConversationRuntime(next.agentEventSequence, next.statuses));
        readyRef.current = true;
        const pending = bufferedEvents.current
          .filter(({ sequence }) => sequence > next.agentEventSequence)
          .sort((left, right) => left.sequence - right.sequence);
        bufferedEvents.current = [];
        for (const event of pending) processEventRef.current(event);
        setError(next.recoveredCorruptState
          ? "Conversation storage was corrupt. The original file was preserved and a fresh store was created."
          : null);
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
    };
  }, [replaceRuntime, replaceState]);

  const sendMessage = useCallback(async (conversationId: string, textValue: string): Promise<boolean> => {
    const text = textValue.trim();
    if (!text || stateRef.current.chats[conversationId]?.isCircle) return false;
    const requestId = crypto.randomUUID();
    const message: TextMessage & { id: string } = {
      id: requestId,
      type: "outgoing",
      text,
      time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      status: "queued",
    };
    replaceRuntime(stageOutgoingMessage(runtimeRef.current, conversationId, message));
    setAcknowledging((current) => ({ ...current, [conversationId]: true }));
    const persisted = await enqueue(() => window.wisp.appendConversationMessage({ conversationId, message }));
    if (!persisted) {
      setAcknowledging((current) => ({ ...current, [conversationId]: false }));
      return false;
    }
    replaceRuntime(removeRuntimeMessage(runtimeRef.current, conversationId, requestId));
    const result = await window.wisp.sendMessage({ conversationId, requestId, text });
    setAcknowledging((current) => ({ ...current, [conversationId]: false }));
    if (result.ok) return true;
    const failed = markOutgoingFailed(runtimeRef.current, stateRef.current.chats, conversationId, requestId, result.error);
    replaceRuntime(failed);
    const outgoing = getRuntimeMessage(failed, conversationId, requestId);
    if (outgoing) void enqueue(() => window.wisp.appendConversationMessage({ conversationId, message: outgoing }));
    return false;
  }, [enqueue, replaceRuntime]);

  const retryMessage = useCallback((conversationId: string, requestId: string): Promise<boolean> => {
    const chats = overlayRuntimeMessages(stateRef.current.chats, runtimeRef.current.messages);
    const original = chats[conversationId]?.messages.find(({ id }) => id === requestId);
    return original?.type === "outgoing" ? sendMessage(conversationId, original.text) : Promise.resolve(false);
  }, [sendMessage]);

  const abort = useCallback(async (conversationId: string): Promise<boolean> => {
    const result = await window.wisp.abortConversation({ conversationId });
    if (result.ok) return true;
    setError(result.error.message);
    return false;
  }, []);

  const chats = useMemo(() => overlayRuntimeMessages(state.chats, runtime.messages), [runtime.messages, state.chats]);

  return {
    chats,
    statuses: runtime.statuses,
    activity: runtime.activity,
    conversationErrors: runtime.errors,
    acknowledging,
    loading,
    error,
    create: useCallback((conversation) => enqueue(() => window.wisp.createConversation({ conversation })), [enqueue]),
    update: useCallback((conversationId, changes) => enqueue(() => window.wisp.updateConversation({ conversationId, changes })), [enqueue]),
    delete: useCallback((conversationId) => enqueue(() => window.wisp.deleteConversation({ conversationId })), [enqueue]),
    appendMessage: useCallback((conversationId, message) => enqueue(() => window.wisp.appendConversationMessage({ conversationId, message })), [enqueue]),
    answerPrompt: useCallback((conversationId, messageId, answer) => enqueue(() => window.wisp.answerConversationPrompt({ conversationId, messageId, answer })), [enqueue]),
    markRead: useCallback((conversationId) => enqueue(() => window.wisp.markConversationRead({ conversationId })), [enqueue]),
    sendMessage,
    retryMessage,
    abort,
  };
}
