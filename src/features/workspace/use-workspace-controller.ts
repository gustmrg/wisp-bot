import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import type {
  Chat,
  ChatChanges,
  ChatCollection,
  ChatId,
  ManagedConversationStatus,
  NewChat,
} from "../../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../../shared/tool-policy";
import type { BackendError } from "../../../shared/contracts";
import { usePersistedPreferences } from "@/features/persistence/use-persisted-preferences";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import { createChatIdFactory, selectActiveChatId } from "@/features/workspace/workspace-actions";
import { useConversations } from "@/hooks/use-conversations";
import type { AppPreferences } from "@/lib/app-preferences";
import type { ToolActivityView } from "@/lib/conversation-stream";
import { applyTheme } from "@/lib/theme";

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
  error: string | null;
  preferences: AppPreferences;
  persistenceStatus: PersistenceStatus;
  persistenceError: string | null;
  selectChat: (chatId: ChatId) => void;
  createChat: (chat: NewChat) => Promise<boolean>;
  updateActiveChat: (changes: ChatChanges) => Promise<boolean>;
  deleteActiveChat: () => Promise<boolean>;
  sendMessage: (text: string) => Promise<boolean>;
  answerPrompt: (messageId: string | undefined, answer: string) => Promise<boolean>;
  retryMessage: (messageId: string | undefined) => Promise<boolean>;
  abortActiveChat: () => Promise<boolean>;
  resolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => Promise<boolean>;
  updatePreferences: (preferences: AppPreferences) => void;
}

export function useWorkspaceController(): WorkspaceController {
  const conversations = useConversations();
  const persistedPreferences = usePersistedPreferences();
  const { preferences } = persistedPreferences;
  const [activeChatId, setActiveChatId] = useState<ChatId>("");
  const [toolPolicyLoaded, setToolPolicyLoaded] = useState(false);
  const [createChatId] = useState(createChatIdFactory);
  const activeChat = conversations.chats[activeChatId];

  useLayoutEffect(() => applyTheme(preferences.theme), [preferences.theme]);

  useEffect(() => {
    let cancelled = false;
    void window.wisp.getToolPolicy().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        persistedPreferences.setPreferences((current) => {
          const backendIsDefault = result.value.autoReview && result.value.rules.length === 0;
          const localHasPolicy = !current.autoReview || current.autoReviewRules.length > 0;
          if (backendIsDefault && localHasPolicy) return current;
          return { ...current, autoReview: result.value.autoReview, autoReviewRules: [...result.value.rules] };
        });
      }
      setToolPolicyLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [persistedPreferences.setPreferences]);

  useEffect(() => {
    if (!toolPolicyLoaded) return;
    void window.wisp.saveToolPolicy({ autoReview: preferences.autoReview, rules: preferences.autoReviewRules });
  }, [preferences.autoReview, preferences.autoReviewRules, toolPolicyLoaded]);

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
    (changes: ChatChanges): Promise<boolean> =>
      activeChatId ? conversations.update(activeChatId, changes) : Promise.resolve(false),
    [activeChatId, conversations.update],
  );

  const deleteActiveChat = useCallback(
    (): Promise<boolean> => (activeChatId ? conversations.delete(activeChatId) : Promise.resolve(false)),
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
      const policy = await window.wisp.getToolPolicy();
      if (policy.ok) {
        persistedPreferences.setPreferences((current) => ({
          ...current,
          autoReview: policy.value.autoReview,
          autoReviewRules: [...policy.value.rules],
        }));
      }
      return resolved;
    },
    [conversations.resolveApproval, persistedPreferences.setPreferences],
  );

  const updatePreferences = useCallback(
    (next: AppPreferences): void => persistedPreferences.setPreferences(next),
    [persistedPreferences.setPreferences],
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
    error: conversations.error,
    preferences,
    persistenceStatus: persistedPreferences.status,
    persistenceError: persistedPreferences.error ?? conversations.error,
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
