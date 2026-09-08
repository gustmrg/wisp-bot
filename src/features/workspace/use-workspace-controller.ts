import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useBackend } from "@/features/backend/backend-provider";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import { usePersistedPreferences } from "@/features/persistence/use-persisted-preferences";
import { createChatIdFactory, selectActiveChatId } from "@/features/workspace/workspace-actions";
import { useConversationHistory } from "@/hooks/use-conversation-history";
import { useConversations } from "@/hooks/use-conversations";
import type { AppPreferences } from "@/lib/app-preferences";
import type { ToolActivityView } from "@/lib/conversation-stream";
import { applyTheme } from "@/lib/theme";
import type { BackendError } from "../../../shared/contracts";
import type {
  Chat,
  ChatChanges,
  ChatCollection,
  ChatId,
  ManagedConversationStatus,
  NewChat,
} from "../../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest, ToolPolicySettings } from "../../../shared/tool-policy";

export interface WorkspaceController {
  chats: ChatCollection;
  activeChatId: ChatId;
  activeChat: Chat | undefined;
  statuses: Record<string, ManagedConversationStatus>;
  activity: Record<string, string | undefined>;
  conversationErrors: Record<string, BackendError | undefined>;
  acknowledging: Record<string, boolean | undefined>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  toolActivities: Record<string, ReadonlyArray<ToolActivityView>>;
  loading: boolean;
  loadEarlier: () => Promise<void>;
  hasEarlier: boolean;
  loadingHistory: boolean;
  historyError?: string;
  error: string | null;
  preferences: AppPreferences;
  persistenceStatus: PersistenceStatus;
  persistenceError: string | null;
  selectChat: (chatId: ChatId) => void;
  createChat: (chat: NewChat) => Promise<boolean>;
  updateActiveChat: (changes: ChatChanges, revision?: number) => Promise<boolean>;
  deleteActiveChat: (revision?: number) => Promise<boolean>;
  sendMessage: (text: string) => Promise<boolean>;
  answerPrompt: (messageId: string | undefined, answer: string) => Promise<boolean>;
  retryMessage: (messageId: string | undefined) => Promise<boolean>;
  abortActiveChat: () => Promise<boolean>;
  resolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
  updatePreferences: (preferences: AppPreferences) => void;
}

export function useWorkspaceController(): WorkspaceController {
  const { api, remote } = useBackend();
  const conversations = useConversations();
  const persistedPreferences = usePersistedPreferences();
  const [toolPolicy, setToolPolicy] = useState<ToolPolicySettings>();
  const preferences = useMemo(
    () =>
      toolPolicy
        ? {
            ...persistedPreferences.preferences,
            autoReview: toolPolicy.autoReview,
            autoReviewRules: [...toolPolicy.rules],
          }
        : persistedPreferences.preferences,
    [persistedPreferences.preferences, toolPolicy],
  );
  const acceptPolicy = useCallback((next: ToolPolicySettings) => {
    setToolPolicy((current) =>
      current?.revision !== undefined && next.revision !== undefined && current.revision > next.revision
        ? current
        : next,
    );
  }, []);
  const [activeChatId, setActiveChatId] = useState<ChatId>("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [createChatId] = useState(createChatIdFactory);
  const history = useConversationHistory(conversations.chats[activeChatId]);
  const activeChat = history.chat;

  useLayoutEffect(() => applyTheme(preferences.theme), [preferences.theme]);

  useEffect(() => {
    let cancelled = false;
    async function loadPolicy() {
      try {
        const result = await api.getToolPolicy();
        if (cancelled) return;
        if (!result.ok) {
          setPolicyError(result.error.message);
          return;
        }
        acceptPolicy(result.value);
        persistedPreferences.setPreferences((current) =>
          current.autoReview === result.value.autoReview &&
          JSON.stringify(current.autoReviewRules) === JSON.stringify(result.value.rules)
            ? current
            : { ...current, autoReview: result.value.autoReview, autoReviewRules: [...result.value.rules] },
        );
        setPolicyError(null);
      } catch {
        if (!cancelled) setPolicyError("Could not load the server tool policy.");
      }
    }
    void loadPolicy();
    const unsubscribe = remote ? api.subscribeToConversationState?.(() => void loadPolicy()) : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, remote, acceptPolicy, persistedPreferences.setPreferences]);

  useEffect(() => {
    if (!conversations.chats[activeChatId]) {
      setActiveChatId(selectActiveChatId(conversations.chats, activeChatId));
    }
  }, [activeChatId, conversations.chats]);

  const selectChat = useCallback(
    (chatId: ChatId): void => {
      if (!conversations.chats[chatId]) return;
      setActiveChatId(chatId);
      if (conversations.chats[chatId].unread) void conversations.markRead(chatId);
    },
    [conversations.chats, conversations.markRead],
  );

  const createChat = useCallback(
    async (chat: NewChat): Promise<boolean> => {
      const id = createChatId(conversations.chats);
      const created = await conversations.create(
        chat.kind === "circle"
          ? {
              ...chat,
              id,
              isActive: false,
              preview: "This is the beginning of the circle.",
              timestamp: "Now",
              messages: [
                {
                  id: crypto.randomUUID(),
                  status: "complete",
                  type: "time",
                  text: "This is the beginning of the circle",
                },
              ],
            }
          : {
              ...chat,
              id,
              isActive: true,
              preview: "Ready for the first task.",
              timestamp: "Now",
              messages: [],
            },
      );
      if (created) setActiveChatId(id);
      return created;
    },
    [conversations.chats, conversations.create, createChatId],
  );

  const updateActiveChat = useCallback(
    (changes: ChatChanges, revision?: number): Promise<boolean> =>
      activeChatId ? conversations.update(activeChatId, changes, revision) : Promise.resolve(false),
    [activeChatId, conversations.update],
  );

  const deleteActiveChat = useCallback(
    (revision?: number): Promise<boolean> =>
      activeChatId ? conversations.delete(activeChatId, revision) : Promise.resolve(false),
    [activeChatId, conversations.delete],
  );

  const sendMessage = useCallback(
    (text: string): Promise<boolean> =>
      activeChat?.kind === "wisp" ? conversations.sendMessage(activeChat.id, text) : Promise.resolve(false),
    [activeChat, conversations.sendMessage],
  );

  const answerPrompt = useCallback(
    (messageId: string | undefined, answer: string): Promise<boolean> =>
      activeChatId && messageId ? conversations.answerPrompt(activeChatId, messageId, answer) : Promise.resolve(false),
    [activeChatId, conversations.answerPrompt],
  );

  const retryMessage = useCallback(
    (messageId: string | undefined): Promise<boolean> =>
      activeChatId && messageId?.endsWith(":assistant")
        ? conversations.retryMessage(activeChatId, messageId.slice(0, -":assistant".length))
        : Promise.resolve(false),
    [activeChatId, conversations.retryMessage],
  );

  const abortActiveChat = useCallback(
    (): Promise<boolean> => (activeChatId ? conversations.abort(activeChatId) : Promise.resolve(false)),
    [activeChatId, conversations.abort],
  );

  const resolveApproval = useCallback(
    async (request: ToolApprovalRequest, decision: ToolApprovalDecision): Promise<boolean> => {
      const resolved = await conversations.resolveApproval(request, decision);
      if (!resolved || decision !== "block") return resolved;
      const policy = await api.getToolPolicy();
      if (policy.ok) {
        acceptPolicy(policy.value);
        persistedPreferences.setPreferences((current) => ({
          ...current,
          autoReview: policy.value.autoReview,
          autoReviewRules: [...policy.value.rules],
        }));
      }
      return resolved;
    },
    [api, conversations.resolveApproval, acceptPolicy, persistedPreferences.setPreferences],
  );

  const updatePreferences = useCallback(
    (next: AppPreferences): void => {
      const policyChanged =
        next.autoReview !== preferences.autoReview ||
        JSON.stringify(next.autoReviewRules) !== JSON.stringify(preferences.autoReviewRules);
      // Device preferences never implicitly write the server's tool policy.
      persistedPreferences.setPreferences({
        ...next,
        autoReview: preferences.autoReview,
        autoReviewRules: preferences.autoReviewRules,
      });
      if (!policyChanged) return;
      if (remote && !toolPolicy) {
        setPolicyError("The server tool policy is still loading. Try again after it loads.");
        return;
      }
      void api
        .saveToolPolicy({ autoReview: next.autoReview, rules: next.autoReviewRules }, toolPolicy?.revision)
        .then(async (result) => {
          if (result.ok) {
            acceptPolicy(result.value);
            persistedPreferences.setPreferences((current) => ({
              ...current,
              autoReview: result.value.autoReview,
              autoReviewRules: [...result.value.rules],
            }));
            setPolicyError(null);
          } else {
            setPolicyError(result.error.message);
            const current = await api.getToolPolicy();
            if (current.ok) {
              acceptPolicy(current.value);
              persistedPreferences.setPreferences((value) => ({
                ...value,
                autoReview: current.value.autoReview,
                autoReviewRules: [...current.value.rules],
              }));
            }
          }
        })
        .catch(() => setPolicyError("Could not save the server tool policy."));
    },
    [
      api,
      remote,
      toolPolicy,
      acceptPolicy,
      preferences.autoReview,
      preferences.autoReviewRules,
      persistedPreferences.setPreferences,
    ],
  );

  return {
    chats: conversations.chats,
    activeChatId,
    activeChat,
    statuses: conversations.statuses,
    activity: conversations.activity,
    conversationErrors: conversations.conversationErrors,
    acknowledging: conversations.acknowledging,
    approvals: conversations.approvals,
    toolActivities: conversations.toolActivities,
    loading: conversations.loading,
    loadEarlier: history.loadEarlier,
    hasEarlier: history.hasEarlier,
    loadingHistory: history.loadingHistory,
    historyError: history.historyError,
    error: conversations.error,
    preferences,
    persistenceStatus: persistedPreferences.status,
    persistenceError: policyError ?? persistedPreferences.error ?? conversations.error,
    selectChat,
    createChat,
    updateActiveChat,
    deleteActiveChat,
    sendMessage,
    answerPrompt,
    retryMessage,
    abortActiveChat,
    resolveApproval,
    updatePreferences,
  };
}
