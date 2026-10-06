import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import {
  requestIdOfAssistantMessage,
  type ChatChanges,
  type ChatId,
  type ChatSummary,
  type ChatSummaryCollection,
  type ManagedConversationStatus,
  type NewChat,
} from "../../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../../shared/tool-policy";
import type { BackendError, ModelSelection } from "../../../shared/contracts";
import { usePersistedPreferences } from "@/features/persistence/use-persisted-preferences";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import { createChatIdFactory, selectActiveChatId } from "@/features/workspace/workspace-actions";
import { useConversations } from "@/hooks/use-conversations";
import { useNotificationSounds } from "@/hooks/use-notification-sounds";
import type { AppPreferences } from "@/lib/app-preferences";
import type { ToolActivityView } from "@/lib/conversation-stream";
import type { MessageWindow } from "@/lib/message-windows";
import { applyTheme } from "@/lib/theme";

export interface WorkspaceController {
  chats: ChatSummaryCollection;
  activeChatId: ChatId;
  activeChat: ChatSummary | undefined;
  /** The loaded part of the active chat's transcript; undefined until its first page arrives. */
  activeTranscript: MessageWindow | undefined;
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
  /** Opens a chat at one message, such as a search result. */
  selectMessage: (chatId: ChatId, messageId: string) => void;
  loadOlderMessages: () => void;
  loadNewerMessages: () => void;
  showLatestMessages: () => void;
  createChat: (chat: NewChat, model?: ModelSelection | null) => Promise<boolean>;
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
  useNotificationSounds({ preferences, chats: conversations.chats, activeChatId });
  const [toolPolicyLoaded, setToolPolicyLoaded] = useState(false);
  const [createChatId] = useState(createChatIdFactory);
  const activeChat = conversations.chats[activeChatId];
  const activeTranscript = conversations.windows[activeChatId];

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

  // Selecting a chat opens it below. This covers the chats chosen for the
  // user: at startup, after a deletion, and one that was just created.
  const activeChatExists = Boolean(activeChat);
  const activeChatLoaded = Boolean(activeTranscript);
  useEffect(() => {
    if (activeChatExists && !activeChatLoaded) conversations.openConversation(activeChatId);
  }, [activeChatExists, activeChatId, activeChatLoaded, conversations.openConversation]);

  const selectChat = useCallback(
    (chatId: ChatId): void => {
      if (!conversations.chats[chatId]) return;
      setActiveChatId(chatId);
      conversations.openConversation(chatId);
      if (conversations.chats[chatId].unread) void conversations.markRead(chatId);
    },
    [conversations.chats, conversations.markRead, conversations.openConversation],
  );

  const selectMessage = useCallback(
    (chatId: ChatId, messageId: string): void => {
      if (!conversations.chats[chatId]) return;
      setActiveChatId(chatId);
      void conversations.openMessage(chatId, messageId);
      if (conversations.chats[chatId].unread) void conversations.markRead(chatId);
    },
    [conversations.chats, conversations.markRead, conversations.openMessage],
  );

  const loadOlderMessages = useCallback(
    (): void => conversations.loadOlderMessages(activeChatId),
    [activeChatId, conversations.loadOlderMessages],
  );

  const loadNewerMessages = useCallback(
    (): void => conversations.loadNewerMessages(activeChatId),
    [activeChatId, conversations.loadNewerMessages],
  );

  const showLatestMessages = useCallback(
    (): void => conversations.openConversation(activeChatId),
    [activeChatId, conversations.openConversation],
  );

  const createChat = useCallback(
    async (chat: NewChat, model?: ModelSelection | null): Promise<boolean> => {
      const id = createChatId(conversations.chats);
      const timestamp = new Date().toISOString();
      const created = await conversations.create(
        chat.kind === "circle"
          ? {
              ...chat,
              id,
              isActive: false,
              preview: "This is the beginning of the circle.",
              timestamp,
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
              timestamp,
              messages: [],
            },
        chat.kind === "wisp" ? model : undefined,
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
    (messageId: string | undefined): Promise<boolean> => {
      const requestId = messageId ? requestIdOfAssistantMessage(messageId) : null;
      return activeChatId && requestId ? conversations.retryMessage(activeChatId, requestId) : Promise.resolve(false);
    },
    [activeChatId, conversations.retryMessage],
  );

  const abortActiveChat = useCallback(
    (): Promise<boolean> => (activeChatId ? conversations.abort(activeChatId) : Promise.resolve(false)),
    [activeChatId, conversations.abort],
  );

  const resolveApproval = useCallback(
    async (request: ToolApprovalRequest, decision: ToolApprovalDecision): Promise<boolean> => {
      const resolved = await conversations.resolveApproval(request, decision);
      // Lasting decisions change the saved policy; show it in Settings right away.
      if (!resolved || (decision !== "block" && decision !== "allow_always")) return resolved;
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
    activeTranscript,
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
    selectMessage,
    loadOlderMessages,
    loadNewerMessages,
    showLatestMessages,
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
