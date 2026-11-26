import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

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
import { Sidebar, type SidebarEnvironment } from "@/components/sidebar";
import { TeamOverview } from "@/components/team-overview";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateToast } from "@/components/update-toast";
import { WispProfile } from "@/components/wisp-profile";
import type { WispSettingsSection } from "@/components/wisp-settings";
import { APP_METADATA } from "@/config/app-metadata";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { useEnvironmentDirectory } from "@/features/environments/environment-directory";
import { applyEnvironmentChatAction } from "@/features/workspace/workspace-actions";
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
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT } from "@/lib/layout";
import { createEnvironmentApi } from "@/lib/environment-api";
import { consumePendingEnvironmentOpen, openEnvironmentChat } from "@/lib/pending-environment-open";
import { matchesShortcut, TOGGLE_SIDEBAR_SHORTCUT } from "@/lib/shortcuts";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import type { SettingsPluginId } from "@/lib/plugin-access";
import { createWispFromTemplate } from "@/lib/create-wisp-from-template";
import { uniqueWispName } from "@/lib/wisp-template-actions";
import { rememberWorkspace, workspaceMemory } from "@/lib/workspace-memory";
import { CHIEF_WISP } from "../shared/chief-wisp";
import { LOCAL_CONNECTION_ID } from "../shared/connections";
import type { WispTemplateEntry } from "../shared/wisp-template";

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
  const connectionsView = useContext(ActiveConnectionContext);
  const activeEnvironmentId = connectionsView?.activeId ?? LOCAL_CONNECTION_ID;
  const directory = useEnvironmentDirectory();
  // A remount for another environment keeps the window as it was: no splash while it reloads.
  const [reopened] = useState(() => workspaceMemory().opened);
  useEffect(() => {
    if (!workspace.loading) rememberWorkspace({ opened: true });
  }, [workspace.loading]);
  /** Until this environment's own state loads, the list shows what the directory knows of it. */
  const activeListing = workspace.loading
    ? directory.environments.find(({ profile }) => profile.id === activeEnvironmentId)
    : undefined;
  const otherEnvironments = useMemo<ReadonlyArray<SidebarEnvironment>>(
    () =>
      directory.environments
        .filter(({ profile }) => profile.id !== activeEnvironmentId)
        .map((entry) => ({
          id: entry.profile.id,
          name: entry.profile.name,
          kind: entry.profile.kind,
          stale: entry.phase === "reconnecting",
          chats: entry.chats,
          statuses: entry.statuses,
          approvals: entry.approvals,
          activity: entry.activity,
        })),
    [directory.environments, activeEnvironmentId],
  );
  const activeProfile = connectionsView?.profiles.find(({ id }) => id === activeEnvironmentId);
  const activeEnvironmentLabel =
    directory.enabled && activeProfile && activeProfile.kind !== "local"
      ? { name: activeProfile.name, kind: activeProfile.kind }
      : undefined;
  const mobile = useMobileLayout();
  const [mainView, setMainView] = useState<"chat" | "team">("chat");
  const [mobilePage, setMobilePage] = useState<"list" | "chat" | "approvals" | "team">("list");
  const [detailsOpen, setDetailsOpen] = useState(false);
  // On a phone a Wisp's settings start from its profile.
  const [profileOpen, setProfileOpen] = useState(false);
  const [detailsSection, setDetailsSection] = useState<WispSettingsSection | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const settingsDialog = useRef<AppSettingsDialogHandle>(null);
  const navigationVersion = useRef(0);
  // A template to customize, chosen in Settings; the create dialog shows it until it closes.
  const [templateToCustomize, setTemplateToCustomize] = useState<WispTemplateEntry | null>(null);
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
  const activeChatShown =
    pageVisible && (mobile ? mobilePage === "chat" && !detailsOpen && !profileOpen : mainView === "chat");
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

  /** Creates a Wisp and shows its conversation, from the create dialog or a template. */
  async function createWisp(...[wisp, options]: Parameters<typeof workspace.createWisp>): Promise<string | null> {
    const id = await workspace.createWisp(wisp, options);
    if (id) {
      navigationVersion.current += 1;
      setMainView("chat");
      if (mobile) setDetailsOpen(false);
      setMobilePage("chat");
    }
    return id;
  }

  function selectChat(chatId: string) {
    setKeptUnreadChatId(null);
    navigationVersion.current += 1;
    workspace.selectChat(chatId);
    setMainView("chat");
    if (mobile) setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("chat");
  }

  const pendingOpenCheckedRef = useRef(false);
  useEffect(() => {
    if (workspace.loading || pendingOpenCheckedRef.current) return;
    pendingOpenCheckedRef.current = true;
    const pending = consumePendingEnvironmentOpen(activeEnvironmentId);
    if (!pending || !workspace.chats[pending.conversationId]) return;
    setKeptUnreadChatId(null);
    navigationVersion.current += 1;
    workspace.selectChat(pending.conversationId);
    setMainView("chat");
    setProfileOpen(false);
    setMobilePage("chat");
    if (pending.openDetails) {
      if (mobile && workspace.chats[pending.conversationId]?.kind === "wisp") {
        setProfileOpen(true);
      } else {
        setDetailsSection(undefined);
        setDetailsOpen(true);
      }
    }
  }, [workspace.loading, workspace.chats, workspace.selectChat, activeEnvironmentId, mobile]);

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
    setMainView("chat");
    if (mobile) setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("chat");
  }

  function selectEnvironmentChat(environmentId: string, chatId: string) {
    navigationVersion.current += 1;
    void openEnvironmentChat(environmentId, chatId);
  }

  function applyOtherEnvironmentChatAction(environmentId: string, chatId: string, action: ChatListAction) {
    const chat = otherEnvironments.find(({ id }) => id === environmentId)?.chats[chatId];
    if (!chat) return;
    void applyEnvironmentChatAction(createEnvironmentApi(environmentId, activeEnvironmentId), chat, action);
  }

  function showConversations() {
    navigationVersion.current += 1;
    setDetailsOpen(false);
    setProfileOpen(false);
    setMobilePage("list");
  }

  function showTeam() {
    navigationVersion.current += 1;
    setDetailsOpen(false);
    setProfileOpen(false);
    setMainView("team");
    setMobilePage("team");
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

  function showSettings(
    section: SettingsEntrySection,
    pluginId?: SettingsPluginId,
    storageConversationId?: string,
    environmentId?: string,
  ) {
    navigationVersion.current += 1;
    settingsDialog.current?.open(section, pluginId, storageConversationId, environmentId);
  }

  async function createCircle(circle: Parameters<typeof workspace.createCircle>[0]): Promise<boolean> {
    const created = await workspace.createCircle(circle);
    if (created) {
      navigationVersion.current += 1;
      setMainView("chat");
      if (mobile) setDetailsOpen(false);
      setMobilePage("chat");
    }
    return created;
  }

  const showTeamMain = mobile ? mobilePage === "team" : mainView === "team";
  const activeWorkspaceSnapshot = useMemo(
    () => ({
      chats: workspace.chats,
      wisps: workspace.wisps,
      statuses: workspace.statuses,
      activity: workspace.activity,
      approvals: workspace.approvals,
    }),
    [workspace.chats, workspace.wisps, workspace.statuses, workspace.activity, workspace.approvals],
  );

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
  const announceVersion = useCallback(
    (announcedVersion: string) => updatePreferences({ ...latestPreferences.current, announcedVersion }),
    [updatePreferences],
  );

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
              chats={activeListing?.chats ?? workspace.chats}
              currentUser={currentUser}
              width={sidebarPanel.width}
              mobile={mobile}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebar}
              order={workspace.preferences.chatListOrder}
              hidden={mobile && (mobilePage !== "list" || detailsOpen)}
              statuses={activeListing?.statuses ?? workspace.statuses}
              activity={activeListing?.activity ?? workspace.activity}
              approvals={activeListing?.approvals ?? workspace.approvals}
              failedChats={workspace.failedChats}
              loading={workspace.loading && !activeListing}
              error={workspace.error}
              createFromTemplate={templateToCustomize}
              onCreateFromTemplateClosed={() => setTemplateToCustomize(null)}
              onCreate={createWisp}
              onCreateCircle={createCircle}
              onOpenSearch={() => showSearch(true)}
              onOpenSettings={() => showSettings("general")}
              onOpenTeam={showTeam}
              teamActive={showTeamMain}
              onOpenTemplates={() => showSettings("templates")}
              onOpenApprovals={showApprovals}
              onResizeStart={sidebarPanel.onResizeStart}
              onSelectChat={selectChat}
              onChatAction={applyChatAction}
              otherEnvironments={otherEnvironments}
              {...(activeEnvironmentLabel ? { activeEnvironment: activeEnvironmentLabel } : {})}
              onSelectEnvironmentChat={selectEnvironmentChat}
              onEnvironmentChatAction={applyOtherEnvironmentChatAction}
            />
            {showTeamMain ? (
              <TeamOverview
                mobile={mobile}
                activeWorkspace={activeWorkspaceSnapshot}
                unreadCount={unreadCount}
                approvalCount={approvalCount}
                onCreateWisp={createWisp}
                onCreateCircle={createCircle}
                onOpenTemplates={() => showSettings("templates")}
                onResolveActiveApproval={workspace.resolveApproval}
                onOpenActiveChat={(conversationId, options) => {
                  selectChat(conversationId);
                  if (options?.openDetails) {
                    if (mobile && workspace.chats[conversationId]?.kind === "wisp") setProfileOpen(true);
                    else showDetails(true);
                  }
                }}
                onOpenEnvironmentSettings={(environmentId, unpaired) => {
                  if (unpaired) showSettings("connections");
                  else showSettings("profile", undefined, undefined, environmentId);
                }}
                onConversations={showConversations}
                onOpenApprovals={showApprovals}
                onOpenSettings={() => showSettings("general")}
              />
            ) : workspace.activeChat ? (
              <ChatPanel
                hidden={mobile && (mobilePage !== "chat" || detailsOpen || profileOpen)}
                onBack={mobile ? showConversations : undefined}
                chat={workspace.activeChat}
                circleToolCalls={workspace.preferences.circleToolCalls}
                wisps={workspace.wisps}
                transcript={workspace.activeTranscript}
                status={workspace.statuses[workspace.activeChat.id] ?? "configuration_required"}
                activity={workspace.activity[workspace.activeChat.id]}
                workingMembers={workspace.workingMembers[workspace.activeChat.id]}
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
                onOpenProviders={() => showSettings("providers")}
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
                onResolveApproval={workspace.resolveApproval}
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
                onResolve={workspace.resolveApproval}
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
            onUseTemplate={({ template }) =>
              createWispFromTemplate(
                template,
                wisps.map(({ name }) => name),
                createWisp,
              )
            }
            onCustomizeTemplate={(entry) =>
              setTemplateToCustomize({
                ...entry,
                template: {
                  ...entry.template,
                  name: uniqueWispName(
                    entry.template.name,
                    wisps.map(({ name }) => name),
                  ),
                },
              })
            }
          />
          <UpdateToast
            displayName={APP_METADATA.displayName}
            announcedVersion={workspace.preferences.announcedVersion}
            onAnnounced={announceVersion}
          />
          {/* The splash from opening stays until the Wisps have loaded. */}
          <SplashOverlay ready={reopened || !workspace.loading} />
        </TooltipProvider>
      </ReplyPaceProvider>
    </TimeZoneProvider>
  );
}
