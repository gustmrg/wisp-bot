import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import {
  requestIdOfAssistantMessage,
  type ChatChanges,
  type ChatId,
  type ManagedConversationStatus,
  type NewCircle,
  type NewWisp,
  type WispChanges,
  type WispCollection,
} from "../../../shared/conversations";
import type { ChatView, ChatViewCollection } from "@/chat-data";
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
  wisps: WispCollection;
  chats: ChatViewCollection;
  activeChatId: ChatId;
  activeChat: ChatView | undefined;
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
  /** Creates a Wisp with its own conversation and opens it. */
  createWisp: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model?: ModelSelection | null },
  ) => Promise<boolean>;
  createCircle: (circle: NewCircle) => Promise<boolean>;
  updateWisp: (wispId: string, changes: WispChanges) => Promise<boolean>;
  updateActiveChat: (changes: ChatChanges) => Promise<boolean>;
  /** Deletes the active circle, or the active conversation's Wisp with it. */
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

  const createWisp = useCallback(
    async (
      wisp: NewWisp,
      options: { notifyOnUpdatesEnabled: boolean; model?: ModelSelection | null },
    ): Promise<boolean> => {
      // A Wisp's own conversation shares its ID.
      const id = createChatId(conversations.chats);
      const created = await conversations.createWisp({ ...wisp, id }, options);
      if (created) setActiveChatId(id);
      return created;
    },
    [conversations.chats, conversations.createWisp, createChatId],
  );

  const createCircle = useCallback(
    async (circle: NewCircle): Promise<boolean> => {
      const id = createChatId(conversations.chats);
      const created = await conversations.createCircle(id, circle);
      if (created) setActiveChatId(id);
      return created;
    },
    [conversations.chats, conversations.createCircle, createChatId],
  );

  const updateActiveChat = useCallback(
    (changes: ChatChanges): Promise<boolean> =>
      activeChatId ? conversations.update(activeChatId, changes) : Promise.resolve(false),
    [activeChatId, conversations.update],
  );

  const deleteActiveChat = useCallback((): Promise<boolean> => {
    if (!activeChat) return Promise.resolve(false);
    return activeChat.kind === "wisp"
      ? conversations.deleteWisp(activeChat.wispId)
      : conversations.delete(activeChat.id);
  }, [activeChat, conversations.delete, conversations.deleteWisp]);

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
    wisps: conversations.wisps,
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
    createWisp,
    createCircle,
    updateWisp: conversations.updateWisp,
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
