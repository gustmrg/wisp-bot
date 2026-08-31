import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentSettings,
  Chat,
  ChatCollection,
  ConversationStateView,
  Message,
} from "../../shared/conversations";
import type { WispApi } from "../../shared/contracts";
import { initialChats } from "@/chat-data";
import { migrateLegacyChats } from "@/lib/circle-members";

export const LEGACY_STORAGE_KEY = "wisp-bot-ui-v3";

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

function resultError(result: { ok: false; error: { message: string } }): Error {
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
  loading: boolean;
  error: string | null;
  create: (conversation: Chat) => Promise<boolean>;
  update: (conversationId: string, changes: Partial<Omit<AgentSettings, "id" | "isCircle">>) => Promise<boolean>;
  delete: (conversationId: string) => Promise<boolean>;
  appendMessage: (conversationId: string, message: Message) => Promise<boolean>;
  answerPrompt: (conversationId: string, messageId: string, answer: string) => Promise<boolean>;
  markRead: (conversationId: string) => Promise<boolean>;
}

export function useConversations(): ConversationsController {
  const [state, setState] = useState<ConversationStateView>({
    initialized: false,
    chats: {},
    statuses: {},
    recoveredCorruptState: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await bootstrapConversationState(window.wisp, window.localStorage);
        if (!cancelled) {
          setState(next);
          setError(next.recoveredCorruptState
            ? "Conversation storage was corrupt. The original file was preserved and a fresh store was created."
            : null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load conversations.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enqueue = useCallback((operation: () => ReturnType<typeof window.wisp.getConversationState>) => {
    const run = mutationQueue.current.then(async () => {
      try {
        const result = await operation();
        if (!result.ok) throw resultError(result);
        setState(result.value);
        setError(null);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The conversation could not be updated.");
        return false;
      }
    });
    mutationQueue.current = run.then(() => undefined);
    return run;
  }, []);

  return {
    chats: state.chats,
    loading,
    error,
    create: useCallback((conversation) => enqueue(() => window.wisp.createConversation({ conversation })), [enqueue]),
    update: useCallback((conversationId, changes) => enqueue(() => window.wisp.updateConversation({ conversationId, changes })), [enqueue]),
    delete: useCallback((conversationId) => enqueue(() => window.wisp.deleteConversation({ conversationId })), [enqueue]),
    appendMessage: useCallback((conversationId, message) => enqueue(() => window.wisp.appendConversationMessage({ conversationId, message })), [enqueue]),
    answerPrompt: useCallback((conversationId, messageId, answer) => enqueue(() => window.wisp.answerConversationPrompt({ conversationId, messageId, answer })), [enqueue]),
    markRead: useCallback((conversationId) => enqueue(() => window.wisp.markConversationRead({ conversationId })), [enqueue]),
  };
}
