import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChatListAction } from "@/chat-data";
import type { SettingsEntrySection } from "@/components/app-settings-dialog";
import type { AppSettingsDialogHandle } from "@/components/app-settings-dialog-host";
import { AppSettingsDialogHost } from "@/components/app-settings-dialog-host";
import { ChatPanel } from "@/components/chat-panel";
import { DetailsPanel } from "@/components/details-panel";
import { MobileApprovals } from "@/components/mobile-approvals";
import { Onboarding, SetupStatus } from "@/components/onboarding";
import { SearchDialog } from "@/components/search-dialog";
import { SplashOverlay, SplashScreen } from "@/components/splash-screen";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateToast } from "@/components/update-toast";
import { WispProfile } from "@/components/wisp-profile";
import type { WispSettingsSection } from "@/components/wisp-settings";
import { APP_METADATA } from "@/config/app-metadata";
import { useWorkspaceController } from "@/features/workspace/use-workspace-controller";
import { useMessageQueue } from "@/hooks/use-message-queue";
import { useMobileLayout } from "@/hooks/use-mobile-layout";
import { usePageVisible } from "@/hooks/use-page-visible";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useScheduledMessages } from "@/hooks/use-scheduled-messages";
import { useSetupGate } from "@/hooks/use-setup-gate";
import { ReplyPaceProvider } from "@/hooks/use-reply-pace";
import { useSystemNotifications } from "@/hooks/use-system-notifications";
import { TimeZoneProvider, useReportedTimeZone } from "@/hooks/use-time-zone";
import { type UserProfileController, useUserProfile } from "@/hooks/use-user-profile";
import { effectiveTimeZone, transcriptionFallbacks } from "@/lib/app-preferences";
import { CHIEF_WISP } from "@/lib/chief-wisp";
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT } from "@/lib/layout";
import { matchesShortcut, TOGGLE_SIDEBAR_SHORTCUT } from "@/lib/shortcuts";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import type { SettingsPluginId } from "@/lib/plugin-access";

export default function App() {
  const userProfile = useUserProfile();
  const setup = useSetupGate(userProfile);
  if (setup.phase === "checking") return <SplashScreen />;
  if (setup.phase === "error") return <SetupStatus message={setup.message} onRetry={setup.retry} />;
  if (setup.phase === "onboarding") {
    return <Onboarding required={setup.required} userProfile={userProfile} onComplete={setup.complete} />;
  }
  return <Workspace userProfile={userProfile} startWithChief={setup.onboarded} />;
}

/** Starts a new topic in a Wisp; resolves with an error message, or null. */
async function startNewTopic(conversationId: string): Promise<string | null> {
  try {
    const result = await window.wisp.manageContext({ conversationId, command: { action: "new_topic" } });
    return result.ok ? null : result.error.message;
  } catch {
    return "Could not start a new topic. Please try again.";
  }
}

function Workspace({
  userProfile,
  startWithChief = false,
}: {
  userProfile: UserProfileController;
  /** Onboarding just finished: a person with no Wisps yet starts talking with Chief. */
  startWithChief?: boolean;
}) {
  const workspace = useWorkspaceController();
  const timeZone = effectiveTimeZone(workspace.preferences);
  useReportedTimeZone(timeZone);
  const scheduledMessages = useScheduledMessages(timeZone);
  const messageQueue = useMessageQueue();
  const name = userProfile.profile.preferredName;
  const currentUser = {
    displayName: name || "Your profile",
    givenName: name,
    initials: name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toUpperCase(),
  };
  const mobile = useMobileLayout();
  const [mobilePage, setMobilePage] = useState<"list" | "chat" | "approvals">("list");
  const [detailsOpen, setDetailsOpen] = useState(false);
  // On a phone a Wisp's settings start from its profile.
  const [profileOpen, setProfileOpen] = useState(false);
  const [detailsSection, setDetailsSection] = useState<WispSettingsSection | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const settingsDialog = useRef<AppSettingsDialogHandle>(null);
  const navigationVersion = useRef(0);
  const wisps = useMemo(
    () =>
      Object.values(workspace.chats).flatMap((chat) =>
        chat.kind === "wisp"
          ? [{ id: chat.id, name: chat.wisp.name, appearance: chat.wisp.appearance, color: chat.wisp.color }]
          : [],
      ),
    [workspace.chats],
  );
  const conversations = useMemo(() => Object.values(workspace.chats), [workspace.chats]);
  const sidebarPanel = useResizablePanel({
    ...SIDEBAR_LAYOUT.resize,
    defaultWidth: workspace.preferences.sidebarWidth,
    enabled: !mobile,
    onResizeEnd: (sidebarWidth) => workspace.updatePreferences({ ...workspace.preferences, sidebarWidth }),
  });
  const detailsPanel = useResizablePanel({
    ...DETAILS_LAYOUT.resize,
    defaultWidth: workspace.preferences.detailsWidth,
    enabled: !mobile && detailsOpen && Boolean(workspace.activeChat),
    onResizeEnd: (detailsWidth) => workspace.updatePreferences({ ...workspace.preferences, detailsWidth }),
  });

  // Asked once per launch; Chief is an ordinary Wisp, so one the person deleted is not created again.
  const chiefRequested = useRef(false);
  const { createWisp: createWorkspaceWisp, loading: workspaceLoading } = workspace;
  useEffect(() => {
    if (!startWithChief || workspaceLoading || chiefRequested.current || wisps.length > 0) return;
    chiefRequested.current = true;
    void createWorkspaceWisp(CHIEF_WISP, { notifyOnUpdatesEnabled: true, model: null }).then((id) => {
      if (id) setMobilePage("chat");
    });
  }, [startWithChief, workspaceLoading, wisps.length, createWorkspaceWisp]);

  useEffect(() => {
    if (!workspace.activeChat) {
      setDetailsOpen(false);
      setMobilePage((page) => (page === "chat" ? "list" : page));
    }
  }, [workspace.activeChat]);

  const unreadCount = Object.values(workspace.chats).filter((chat) => chat.unread).length;
  const approvalCount = Object.entries(workspace.approvals).reduce(
    (count, [chatId, requests]) => count + (workspace.chats[chatId] ? requests.length : 0),
    0,
  );

  // A reply that arrives while its chat is on screen has been seen.
  const pageVisible = usePageVisible();
  const activeChatShown = pageVisible && (!mobile || (mobilePage === "chat" && !detailsOpen && !profileOpen));
  const activeChatUnread = Boolean(workspace.activeChat?.unread);
  const { markActiveChatRead } = workspace;
  // A conversation the person marked unread stays so while it is open, until they choose it again.
  const [keptUnreadChatId, setKeptUnreadChatId] = useState<string | null>(null);
  const activeChatKeptUnread = keptUnreadChatId === workspace.activeChatId;
  useEffect(() => {
    if (activeChatShown && activeChatUnread && !activeChatKeptUnread) markActiveChatRead();
  }, [activeChatShown, activeChatUnread, activeChatKeptUnread, markActiveChatRead]);

  function applyChatAction(chatId: string, action: ChatListAction) {
    if (action === "unread") setKeptUnreadChatId(chatId);
    void workspace.applyChatAction(chatId, action);
  }

  function selectChat(chatId: string) {
    setKeptUnreadChatId(null);
    navigationVersion.current += 1;
    workspace.selectChat(chatId);
    if (mobile) setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("chat");
  }

  useSystemNotifications({
    preferences: workspace.preferences,
    shownChatId: activeChatShown ? (workspace.activeChatId ?? null) : null,
    onOpen: ({ conversationId }) => {
      if (workspace.chats[conversationId]) selectChat(conversationId);
    },
  });

  function selectMessage(chatId: string, messageId: string) {
    setKeptUnreadChatId(null);
    navigationVersion.current += 1;
    workspace.selectMessage(chatId, messageId);
    if (mobile) setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("chat");
  }

  function showConversations() {
    navigationVersion.current += 1;
    setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("list");
  }

  function showApprovals() {
    navigationVersion.current += 1;
    setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("approvals");
  }

  function showDetails(open: boolean, section?: WispSettingsSection) {
    navigationVersion.current += 1;
    setDetailsSection(section);
    setDetailsOpen(open);
  }

  async function deleteActiveChat() {
    const startedAt = navigationVersion.current;
    const deleted = await workspace.deleteActiveChat();
    if (deleted && startedAt === navigationVersion.current) showConversations();
  }

  /** The gear in a chat: a Wisp's profile on a phone, its settings otherwise. */
  function openChatDetails() {
    if (mobile && workspace.activeChat?.kind === "wisp") {
      navigationVersion.current += 1;
      setProfileOpen(true);
    } else showDetails(true);
  }

  /** A mention in a circle: the Wisp's own conversation, with its profile on a phone and its settings otherwise. */
  function openWisp(wispId: string) {
    if (!workspace.chats[wispId]) return;
    selectChat(wispId);
    if (mobile) setProfileOpen(true);
    else showDetails(true);
  }

  function showSettings(section: SettingsEntrySection, pluginId?: SettingsPluginId, storageConversationId?: string) {
    navigationVersion.current += 1;
    settingsDialog.current?.open(section, pluginId, storageConversationId);
  }

  function showSearch(open: boolean) {
    navigationVersion.current += 1;
    setSearchOpen(open);
  }

  const sidebarCollapsed = !mobile && workspace.preferences.sidebarCollapsed;
  const latestPreferences = useRef(workspace.preferences);
  latestPreferences.current = workspace.preferences;
  const { updatePreferences } = workspace;
  const toggleSidebar = useCallback(() => {
    const preferences = latestPreferences.current;
    updatePreferences({ ...preferences, sidebarCollapsed: !preferences.sidebarCollapsed });
  }, [updatePreferences]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        navigationVersion.current += 1;
        setSearchOpen(true);
        return;
      }
      // Dialogs keep their own keys; a Wisp being created must not lose its dialog's place.
      if (
        !mobile &&
        matchesShortcut(event, TOGGLE_SIDEBAR_SHORTCUT) &&
        !(event.target instanceof Element && event.target.closest("[role='dialog']"))
      ) {
        event.preventDefault();
        if (!event.repeat) toggleSidebar();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mobile, toggleSidebar]);

  return (
    <TimeZoneProvider timeZone={timeZone} timeFormat={workspace.preferences.timeFormat}>
      <ReplyPaceProvider pace={workspace.preferences.replyPace}>
        <TooltipProvider delay={300}>
          <div className="workspace-shell relative flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
            <Sidebar
              activeChatId={workspace.activeChatId}
              chats={workspace.chats}
              currentUser={currentUser}
              width={sidebarPanel.width}
              mobile={mobile}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebar}
              showWispsRow={workspace.preferences.wispsRow}
              order={workspace.preferences.chatListOrder}
              hidden={mobile && (mobilePage !== "list" || detailsOpen)}
              statuses={workspace.statuses}
              activity={workspace.activity}
              approvals={workspace.approvals}
              failedChats={workspace.failedChats}
              loading={workspace.loading}
              error={workspace.error}
              onCreate={async (wisp, options) => {
                const id = await workspace.createWisp(wisp, options);
                if (id) {
                  navigationVersion.current += 1;
                  if (mobile) setDetailsOpen(false);
                  setMobilePage("chat");
                }
                return id;
              }}
              onCreateCircle={async (circle) => {
                const created = await workspace.createCircle(circle);
                if (created) {
                  navigationVersion.current += 1;
                  if (mobile) setDetailsOpen(false);
                  setMobilePage("chat");
                }
                return created;
              }}
              onOpenSearch={() => showSearch(true)}
              onOpenSettings={() => showSettings("general")}
              onOpenApprovals={showApprovals}
              onResolveApproval={(request, decision) => void workspace.resolveApproval(request, decision)}
              onResizeStart={sidebarPanel.onResizeStart}
              onSelectChat={selectChat}
              onChatAction={applyChatAction}
            />
            {workspace.activeChat ? (
              <ChatPanel
                hidden={mobile && (mobilePage !== "chat" || detailsOpen || profileOpen)}
                onBack={mobile ? showConversations : undefined}
                chat={workspace.activeChat}
                wisps={workspace.wisps}
                transcript={workspace.activeTranscript}
                status={workspace.statuses[workspace.activeChat.id] ?? "configuration_required"}
                activity={workspace.activity[workspace.activeChat.id]}
                error={workspace.conversationErrors[workspace.activeChat.id]?.message}
                acknowledging={Boolean(workspace.acknowledging[workspace.activeChat.id])}
                approvals={workspace.approvals[workspace.activeChat.id] ?? []}
                onAnswerPrompt={(messageId, answer) => void workspace.answerPrompt(messageId, answer)}
                onAbort={() => workspace.abortActiveChat()}
                onLoadOlder={workspace.loadOlderMessages}
                onLoadNewer={workspace.loadNewerMessages}
                onShowLatest={workspace.showLatestMessages}
                onOpenDetails={openChatDetails}
                onOpenWisp={openWisp}
                onConfigure={() => showSettings("model")}
                voice={{
                  deviceId: workspace.preferences.microphone,
                  providerId: workspace.preferences.voiceProvider,
                  modelId: workspace.preferences.voiceModel,
                  fallbacks: transcriptionFallbacks(workspace.preferences),
                  language: workspace.preferences.voiceLanguage,
                  autoSend: workspace.preferences.voiceAutoSend,
                  shortcut: workspace.preferences.shortcuts.voiceInput,
                }}
                onConfigureVoice={() => showSettings("voice")}
                onRetry={(messageId) => void workspace.retryMessage(messageId)}
                onResolveApproval={(request, decision) => void workspace.resolveApproval(request, decision)}
                onSend={(text) => void workspace.sendMessage(text)}
                scheduledMessages={scheduledMessages}
                messageQueue={messageQueue}
                onNewTopic={startNewTopic}
                soleWisp={wisps.length === 1}
              />
            ) : (
              <main
                hidden={mobile}
                className={cn(mainPanel, "items-center justify-center text-dim", mobile && "hidden")}
              >
                {workspace.loading ? null : (workspace.error ?? "Create a Wisp to get started.")}
              </main>
            )}
            {mobile && profileOpen && !detailsOpen && mobilePage === "chat" && workspace.activeChat?.kind === "wisp" ? (
              <WispProfile
                chat={workspace.activeChat}
                state={
                  workspace.approvals[workspace.activeChat.id]?.length
                    ? "approval"
                    : workspace.statuses[workspace.activeChat.id] === "working"
                      ? "working"
                      : "idle"
                }
                onBack={() => {
                  navigationVersion.current += 1;
                  setProfileOpen(false);
                }}
                onOpenSection={(section) => showDetails(true, section)}
                onChangeNotifications={(notifyOnUpdatesEnabled) =>
                  void workspace.updateActiveChat({ kind: "wisp", notifyOnUpdatesEnabled })
                }
                onDelete={() => void deleteActiveChat()}
              />
            ) : null}
            {detailsOpen && workspace.activeChat ? (
              <DetailsPanel
                mobile={mobile}
                section={detailsSection}
                backLabel={profileOpen ? "Back to profile" : undefined}
                chat={workspace.activeChat}
                wisps={workspace.wisps}
                width={detailsPanel.width}
                onChange={workspace.updateActiveChat}
                onChangeWisp={workspace.updateWisp}
                onOpenSettings={(target) =>
                  showSettings(
                    target.section,
                    target.section === "plugins" ? target.pluginId : undefined,
                    target.section === "storage" ? target.conversationId : undefined,
                  )
                }
                onClose={() => showDetails(false)}
                onDelete={() => void deleteActiveChat()}
                onResizeStart={detailsPanel.onResizeStart}
              />
            ) : null}
            {mobile && mobilePage === "approvals" ? (
              <MobileApprovals
                chats={workspace.chats}
                approvals={workspace.approvals}
                unreadCount={unreadCount}
                onResolve={(request, decision) => void workspace.resolveApproval(request, decision)}
                onOpenChat={selectChat}
                onConversations={showConversations}
                onSettings={() => showSettings("general")}
              />
            ) : null}
          </div>
          <SearchDialog
            chats={workspace.chats}
            open={searchOpen}
            onOpenChange={showSearch}
            onSelectChat={selectChat}
            onSelectMessage={selectMessage}
          />
          <AppSettingsDialogHost
            ref={settingsDialog}
            appMetadata={APP_METADATA}
            currentUser={currentUser}
            mobile={mobile}
            onOpenConversations={showConversations}
            onOpenApprovals={showApprovals}
            navigationCounts={{ unread: unreadCount, approvals: approvalCount }}
            wisps={wisps}
            conversations={conversations}
            userProfile={userProfile}
            preferences={workspace.preferences}
            persistenceStatus={workspace.persistenceStatus}
            persistenceError={workspace.persistenceError}
            onPreferencesChange={workspace.updatePreferences}
          />
          <UpdateToast displayName={APP_METADATA.displayName} />
          {/* The splash from opening stays until the Wisps have loaded. */}
          <SplashOverlay ready={!workspace.loading} />
        </TooltipProvider>
      </ReplyPaceProvider>
    </TimeZoneProvider>
  );
}
