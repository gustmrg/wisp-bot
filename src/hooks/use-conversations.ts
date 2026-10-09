import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BackendError,
  BackendResult,
  ModelSelection,
  SequencedConversationAgentEvent,
  WispApi,
} from "../../shared/contracts";
import {
  chatSummary,
  type ChatChanges,
  type ChatSummaryCollection,
  type ConversationDelta,
  type ConversationStateView,
  type ManagedConversationStatus,
  type Message,
  type MessagePage,
  type MessagePageRequest,
  type OutgoingMessage,
  type NewCircle,
  type Wisp,
  type WispChanges,
  type WispCollection,
} from "../../shared/conversations";
import type { ChatViewCollection } from "@/chat-data";
import { chatViews } from "@/lib/chat-schema";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { LEGACY_CONVERSATIONS_STORAGE_KEY, MAX_LEGACY_BLOB_BYTES } from "@/features/persistence/storage-policy";
import { LOCAL_CONNECTION_ID } from "../../shared/connections";
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
  setConversationError,
  clearConversationError,
  stageOutgoingMessage,
  type ConversationRuntimeState,
  type StoredConversations,
  type ToolActivityView,
} from "@/lib/conversation-stream";
import {
  applyDeltaToWindow,
  extendWindow,
  isAttached,
  touchOpened,
  windowFromPage,
  type MessageWindow,
} from "@/lib/message-windows";

export const LEGACY_STORAGE_KEY = LEGACY_CONVERSATIONS_STORAGE_KEY;

const NO_MESSAGES: ReadonlyArray<Message> = [];

/**
 * A page request in flight. Changes that arrive meanwhile are applied again
 * once the page lands, because the page may have been read before them.
 */
interface PageLoad {
  /** Replaces the window (latest or around a message) rather than extending it. */
  replaces: boolean;
  deltas: ConversationDelta[];
}

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

/**
 * Loads the backend's conversations, initializing it on first run. Local
 * storage holds this computer's conversations from before the backend stored
 * them, so only this computer's own backend adopts them; a server starts empty.
 */
export async function bootstrapConversationState(
  api: Pick<WispApi, "getConversationState" | "initializeConversations" | "getConnections">,
  storage: Pick<Storage, "getItem" | "removeItem">,
): Promise<ConversationStateView> {
  const connections = await api.getConnections();
  if (!connections.ok) throw resultError(connections);
  const local = connections.value.activeId === LOCAL_CONNECTION_ID;
  const current = await api.getConversationState();
  if (!current.ok) throw resultError(current);
  if (current.value.initialized) {
    // The local backend may have adopted them from its own legacy file instead.
    if (local) storage.removeItem(LEGACY_STORAGE_KEY);
    return current.value;
  }
  const initialized = await api.initializeConversations({ chats: local ? legacyChats(storage) : {} });
  if (!initialized.ok) throw resultError(initialized);
  if (local) storage.removeItem(LEGACY_STORAGE_KEY);
  return initialized.value;
}

export interface ConversationsController {
  wisps: WispCollection;
  /** Every conversation, with the Wisps it involves. */
  chats: ChatViewCollection;
  /** Transcript windows of the conversations opened most recently, with messages still in flight overlaid. */
  windows: Record<string, MessageWindow>;
  statuses: Record<string, ManagedConversationStatus>;
  activity: Record<string, string | undefined>;
  conversationErrors: Record<string, BackendError | undefined>;
  acknowledging: Record<string, boolean | undefined>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  toolActivities: Record<string, ReadonlyArray<ToolActivityView>>;
  loading: boolean;
  error: string | null;
  createWisp: (
    wisp: Wisp,
    options: { notifyOnUpdatesEnabled: boolean; model?: ModelSelection | null },
  ) => Promise<boolean>;
  updateWisp: (wispId: string, changes: WispChanges) => Promise<boolean>;
  deleteWisp: (wispId: string) => Promise<boolean>;
  /** Creates a circle with a new ID; a Wisp's own conversation is created with the Wisp. */
  createCircle: (id: string, circle: NewCircle) => Promise<boolean>;
  update: (conversationId: string, changes: ChatChanges) => Promise<boolean>;
  delete: (conversationId: string) => Promise<boolean>;
  appendMessage: (conversationId: string, message: OutgoingMessage) => Promise<boolean>;
  answerPrompt: (conversationId: string, messageId: string, answer: string) => Promise<boolean>;
  markRead: (conversationId: string) => Promise<boolean>;
  markUnread: (conversationId: string) => Promise<boolean>;
  /** Shows a conversation at its newest messages, loading them unless its window already reaches them. */
  openConversation: (conversationId: string) => void;
  /** Shows a conversation around one message, such as a search result. */
  openMessage: (conversationId: string, messageId: string) => Promise<void>;
  loadOlderMessages: (conversationId: string) => void;
  loadNewerMessages: (conversationId: string) => void;
  sendMessage: (conversationId: string, text: string) => Promise<boolean>;
  retryMessage: (conversationId: string, requestId: string) => Promise<boolean>;
  abort: (conversationId: string) => Promise<boolean>;
  resolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
}

export function useConversations(): ConversationsController {
  const [chats, setChats] = useState<ChatSummaryCollection>({});
  const [wisps, setWisps] = useState<WispCollection>({});
  const [windows, setWindows] = useState<Record<string, MessageWindow>>({});
  const [runtime, setRuntime] = useState<ConversationRuntimeState>(() => createConversationRuntime(0, {}));
  const [pendingAcknowledgements, setPendingAcknowledgements] = useState<Record<string, ReadonlyArray<string>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const chatsRef = useRef(chats);
  const windowsRef = useRef(windows);
  const runtimeRef = useRef(runtime);
  const openedRef = useRef<ReadonlyArray<string>>([]);
  const loadsRef = useRef(new Map<string, PageLoad>());
  const epochRef = useRef(0);
  const readyRef = useRef(false);
  const bufferedEvents = useRef<SequencedConversationAgentEvent[]>([]);
  const processEventRef = useRef<(event: SequencedConversationAgentEvent) => void>(() => undefined);

  const replaceChats = useCallback((next: ChatSummaryCollection): void => {
    chatsRef.current = next;
    setChats(next);
  }, []);

  const replaceWindows = useCallback((next: Record<string, MessageWindow>): void => {
    windowsRef.current = next;
    setWindows(next);
  }, []);

  const replaceRuntime = useCallback((next: ConversationRuntimeState): void => {
    runtimeRef.current = next;
    setRuntime(next);
  }, []);

  const setWindow = useCallback(
    (conversationId: string, next: MessageWindow): void =>
      replaceWindows({ ...windowsRef.current, [conversationId]: next }),
    [replaceWindows],
  );

  // Forgets windows, and page requests still in flight for them, so a late page is ignored.
  const dropWindows = useCallback(
    (conversationIds: ReadonlyArray<string>): void => {
      if (conversationIds.length === 0) return;
      const dropped = new Set(conversationIds);
      for (const conversationId of dropped) loadsRef.current.delete(conversationId);
      openedRef.current = openedRef.current.filter((conversationId) => !dropped.has(conversationId));
      if (!conversationIds.some((conversationId) => windowsRef.current[conversationId])) return;
      replaceWindows(
        Object.fromEntries(
          Object.entries(windowsRef.current).filter(([conversationId]) => !dropped.has(conversationId)),
        ),
      );
    },
    [replaceWindows],
  );

  const replaceState = useCallback(
    (next: ConversationStateView): void => {
      // The full state still carries transcripts; the renderer keeps only summaries and loads pages on demand.
      const summaries = Object.fromEntries(Object.entries(next.chats).map(([id, chat]) => [id, chatSummary(chat)]));
      replaceChats(summaries);
      setWisps(next.wisps);
      dropWindows(
        [...Object.keys(windowsRef.current), ...loadsRef.current.keys()].filter(
          (conversationId) => !summaries[conversationId],
        ),
      );
      replaceRuntime(reconcileConversationRuntime(runtimeRef.current, summaries, next.statuses));
      setPendingAcknowledgements((current) => retainPendingConversations(current, summaries));
    },
    [dropWindows, replaceChats, replaceRuntime],
  );

  // Merges one conversation's change, from a single-chat response or a backend
  // push. A chat deleted in the meantime stays deleted.
  const applyDelta = useCallback(
    (delta: ConversationDelta): void => {
      const conversationId = delta.chat.id;
      if (!chatsRef.current[conversationId]) return;
      replaceChats({ ...chatsRef.current, [conversationId]: delta.chat });
      loadsRef.current.get(conversationId)?.deltas.push(delta);
      const held = windowsRef.current[conversationId];
      const next = held ? applyDeltaToWindow(held, delta) : undefined;
      if (next && next !== held) setWindow(conversationId, next);
      const pruned = pruneSettledRuntimeMessages(runtimeRef.current, conversationId, [
        ...delta.added,
        ...delta.updated,
      ]);
      if (pruned !== runtimeRef.current) replaceRuntime(pruned);
    },
    [replaceChats, replaceRuntime, setWindow],
  );

  /**
   * Reads one page and merges it into the conversation's window. A newer
   * request for the same conversation, or dropping its window, supersedes it.
   */
  const loadPage = useCallback(
    async (request: MessagePageRequest, reportFailure = true): Promise<boolean> => {
      const { conversationId } = request;
      const replaces = request.page === "latest" || request.page === "around";
      const current = windowsRef.current[conversationId];
      if (!replaces && (!current || loadsRef.current.has(conversationId))) return false;
      const load: PageLoad = { replaces, deltas: [] };
      loadsRef.current.set(conversationId, load);
      if (current && !current.loading) setWindow(conversationId, { ...current, loading: true });
      let result: BackendResult<MessagePage>;
      try {
        result = await window.wisp.getConversationMessages(request);
      } catch {
        result = {
          ok: false,
          error: { code: "internal_error", message: "The messages could not be loaded.", retryable: true },
        };
      }
      if (loadsRef.current.get(conversationId) !== load) return false;
      loadsRef.current.delete(conversationId);
      const held = windowsRef.current[conversationId];
      if (!result.ok) {
        if (held) setWindow(conversationId, { ...held, loading: false });
        if (reportFailure) setError(result.error.message);
        return false;
      }
      let next: MessageWindow;
      if (request.page === "latest") {
        epochRef.current += 1;
        next = windowFromPage(epochRef.current, result.value);
      } else if (request.page === "around") {
        epochRef.current += 1;
        next = windowFromPage(epochRef.current, result.value, request.messageId);
      } else if (held) {
        next = extendWindow(held, request.page, result.value);
      } else {
        return false;
      }
      for (const delta of load.deltas) next = applyDeltaToWindow(next, delta);
      setWindow(conversationId, next);
      const pruned = pruneSettledRuntimeMessages(runtimeRef.current, conversationId, result.value.messages);
      if (pruned !== runtimeRef.current) replaceRuntime(pruned);
      return true;
    },
    [replaceRuntime, setWindow],
  );

  const touch = useCallback(
    (conversationId: string): void => {
      const { opened, evicted } = touchOpened(openedRef.current, conversationId);
      openedRef.current = opened;
      dropWindows(evicted);
    },
    [dropWindows],
  );

  const openConversation = useCallback(
    (conversationId: string): void => {
      if (!chatsRef.current[conversationId]) return;
      touch(conversationId);
      if (loadsRef.current.get(conversationId)?.replaces) return;
      const held = windowsRef.current[conversationId];
      if (held && isAttached(held)) return;
      void loadPage({ conversationId, page: "latest" });
    },
    [loadPage, touch],
  );

  const openMessage = useCallback(
    async (conversationId: string, messageId: string): Promise<void> => {
      if (!chatsRef.current[conversationId]) return;
      touch(conversationId);
      const load = loadPage({ conversationId, page: "around", messageId }, false);
      // The message may be gone by now; the conversation still opens, at its newest messages.
      if (!(await load) && !loadsRef.current.has(conversationId)) openConversation(conversationId);
    },
    [loadPage, openConversation, touch],
  );

  const loadOlderMessages = useCallback(
    (conversationId: string): void => {
      const cursor = windowsRef.current[conversationId]?.olderCursor;
      if (cursor) void loadPage({ conversationId, page: "older", cursor });
    },
    [loadPage],
  );

  const loadNewerMessages = useCallback(
    (conversationId: string): void => {
      const cursor = windowsRef.current[conversationId]?.newerCursor;
      if (cursor) void loadPage({ conversationId, page: "newer", cursor });
    },
    [loadPage],
  );

  const stored = useCallback((): StoredConversations => ({ chats: chatsRef.current, windows: windowsRef.current }), []);

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

  const enqueueDelta = useCallback(
    (operation: () => Promise<BackendResult<ConversationDelta>>) => enqueueMutation(operation, applyDelta),
    [applyDelta, enqueueMutation],
  );

  // Events only drive the transient runtime view. The backend persists what they
  // imply (reply text, delivery status) and pushes the stored change afterwards.
  processEventRef.current = (event): void => {
    const next = reduceConversationAgentEvent(runtimeRef.current, event, stored());
    if (next !== runtimeRef.current) replaceRuntime(next);
  };

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.wisp.subscribeToAgentEvents((event) => {
      if (!readyRef.current) bufferedEvents.current.push(event);
      else processEventRef.current(event);
    });
    const unsubscribeChanges = window.wisp.subscribeToConversationChanges((delta) => {
      // Backend messages arrive in send order, so a push received before the
      // bootstrap snapshot is already reflected in that snapshot.
      if (readyRef.current) applyDelta(delta);
    });
    void (async () => {
      try {
        const next = await bootstrapConversationState(window.wisp, window.localStorage);
        if (cancelled) return;
        replaceState(next);
        replaceRuntime(
          createConversationRuntime(
            next.agentEventSequence,
            next.statuses,
            next.pendingToolApprovals,
            next.liveMessages,
          ),
        );
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
  }, [applyDelta, replaceRuntime, replaceState]);

  /** Sends the way servers without a message queue expect: saved to the transcript, then sent. */
  const sendDirectly = useCallback(
    async (conversationId: string, text: string): Promise<boolean> => {
      const requestId = crypto.randomUUID();
      const message: OutgoingMessage & { id: string } = {
        id: requestId,
        type: "outgoing",
        text,
        createdAt: new Date().toISOString(),
        status: "queued",
      };
      // The message belongs at the end, so a window opened elsewhere in the transcript returns there.
      openConversation(conversationId);
      replaceRuntime(stageOutgoingMessage(runtimeRef.current, conversationId, message));
      setPendingAcknowledgements((current) => addPendingRequest(current, conversationId, requestId));
      const persisted = await enqueueDelta(() => window.wisp.appendConversationMessage({ conversationId, message }));
      if (!persisted) {
        setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, requestId));
        return false;
      }
      replaceRuntime(removeRuntimeMessage(runtimeRef.current, conversationId, requestId));
      const result = await window.wisp.sendMessage({ conversationId, requestId, text });
      setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, requestId));
      if (result.ok) return true;
      const failed = markOutgoingFailed(runtimeRef.current, stored(), conversationId, requestId, result.error);
      replaceRuntime(failed);
      const outgoing = getRuntimeMessage(failed, conversationId, requestId);
      if (outgoing?.type === "outgoing") {
        const message: OutgoingMessage = { ...outgoing, type: "outgoing" };
        void enqueueDelta(() => window.wisp.appendConversationMessage({ conversationId, message }));
      }
      return false;
    },
    [enqueueDelta, openConversation, replaceRuntime, stored],
  );

  /**
   * Puts the message in the Wisp's queue. It joins the transcript when the
   * Wisp takes it, which the backend pushes as a change.
   */
  const sendMessage = useCallback(
    async (conversationId: string, textValue: string): Promise<boolean> => {
      const text = textValue.trim();
      if (!text || chatsRef.current[conversationId]?.kind !== "wisp") return false;
      const status = runtimeRef.current.statuses[conversationId];
      if (status !== "idle" && status !== "working") return false;
      // The reply belongs at the end, so a window opened elsewhere in the transcript returns there.
      openConversation(conversationId);
      const acknowledgement = crypto.randomUUID();
      setPendingAcknowledgements((current) => addPendingRequest(current, conversationId, acknowledgement));
      let result: BackendResult<unknown>;
      try {
        result = await window.wisp.queueMessage({ conversationId, text });
      } catch {
        result = {
          ok: false,
          error: { code: "internal_error", message: "The message could not be sent.", retryable: true },
        };
      } finally {
        setPendingAcknowledgements((current) => removePendingRequest(current, conversationId, acknowledgement));
      }
      if (result.ok) {
        replaceRuntime(clearConversationError(runtimeRef.current, conversationId));
        return true;
      }
      if (result.error.code === "unsupported") return sendDirectly(conversationId, text);
      replaceRuntime(setConversationError(runtimeRef.current, conversationId, result.error));
      return false;
    },
    [openConversation, replaceRuntime, sendDirectly],
  );

  const retryMessage = useCallback(
    async (conversationId: string, requestId: string): Promise<boolean> => {
      // The failed message was just sent, so the window normally holds it; otherwise the backend does.
      let original =
        getRuntimeMessage(runtimeRef.current, conversationId, requestId) ??
        windowsRef.current[conversationId]?.messages.find(({ id }) => id === requestId);
      if (!original) {
        const page = await window.wisp.getConversationMessages({
          conversationId,
          page: "around",
          messageId: requestId,
        });
        original = page.ok ? page.value.messages.find(({ id }) => id === requestId) : undefined;
      }
      return original?.type === "outgoing" ? sendMessage(conversationId, original.text) : false;
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

  const visibleWindows = useMemo(() => {
    const result: Record<string, MessageWindow> = {};
    for (const [conversationId, held] of Object.entries(windows)) {
      const messages = overlayRuntimeMessages(
        held.messages,
        runtime.messages[conversationId] ?? NO_MESSAGES,
        isAttached(held),
      );
      result[conversationId] = messages === held.messages ? held : { ...held, messages };
    }
    return result;
  }, [runtime.messages, windows]);
  const acknowledging = useMemo(
    () =>
      Object.fromEntries(Object.entries(pendingAcknowledgements).map(([id, requests]) => [id, requests.length > 0])),
    [pendingAcknowledgements],
  );

  const views = useMemo(() => chatViews(chats, wisps), [chats, wisps]);

  return {
    wisps,
    chats: views,
    windows: visibleWindows,
    statuses: runtime.statuses,
    activity: runtime.activity,
    conversationErrors: runtime.errors,
    acknowledging,
    approvals: runtime.approvals,
    toolActivities: runtime.toolActivities,
    loading,
    error,
    createWisp: useCallback(
      (wisp: Wisp, options: { notifyOnUpdatesEnabled: boolean; model?: ModelSelection | null }) =>
        enqueue(() =>
          window.wisp.createWisp({
            wisp,
            notifyOnUpdatesEnabled: options.notifyOnUpdatesEnabled,
            model: options.model ?? null,
          }),
        ),
      [enqueue],
    ),
    updateWisp: useCallback(
      (wispId: string, changes: WispChanges) => enqueue(() => window.wisp.updateWisp({ wispId, changes })),
      [enqueue],
    ),
    deleteWisp: useCallback((wispId: string) => enqueue(() => window.wisp.deleteWisp({ wispId })), [enqueue]),
    createCircle: useCallback(
      (id: string, circle: NewCircle) =>
        enqueue(() =>
          window.wisp.createConversation({
            conversation: {
              ...circle,
              id,
              preview: "This is the beginning of the circle.",
              messages: [
                {
                  id: crypto.randomUUID(),
                  status: "complete",
                  type: "time",
                  text: "This is the beginning of the circle",
                },
              ],
            },
          }),
        ),
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
        enqueueDelta(() => window.wisp.appendConversationMessage({ conversationId, message })),
      [enqueueDelta],
    ),
    answerPrompt: useCallback(
      (conversationId, messageId, answer) =>
        enqueueDelta(() => window.wisp.answerConversationPrompt({ conversationId, messageId, answer })),
      [enqueueDelta],
    ),
    markRead: useCallback(
      (conversationId) => enqueueDelta(() => window.wisp.markConversationRead({ conversationId })),
      [enqueueDelta],
    ),
    markUnread: useCallback(
      (conversationId) => enqueueDelta(() => window.wisp.markConversationUnread({ conversationId })),
      [enqueueDelta],
    ),
    openConversation,
    openMessage,
    loadOlderMessages,
    loadNewerMessages,
    sendMessage,
    retryMessage,
    abort,
    resolveApproval,
  };
}
