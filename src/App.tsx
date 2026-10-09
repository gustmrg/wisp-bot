import { useEffect, useMemo, useRef, useState } from "react";

import { AppSettingsDialogHost } from "@/components/app-settings-dialog-host";
import type { AppSettingsDialogHandle } from "@/components/app-settings-dialog-host";
import type { SettingsEntrySection } from "@/components/app-settings-dialog";
import { ChatPanel } from "@/components/chat-panel";
import { DetailsPanel } from "@/components/details-panel";
import { SearchDialog } from "@/components/search-dialog";
import { MobileApprovals } from "@/components/mobile-approvals";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateToast } from "@/components/update-toast";
import { APP_METADATA } from "@/config/app-metadata";
import { Onboarding, SetupStatus } from "@/components/onboarding";
import { useSetupGate } from "@/hooks/use-setup-gate";
import { useUserProfile, type UserProfileController } from "@/hooks/use-user-profile";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useMessageQueue } from "@/hooks/use-message-queue";
import { useScheduledMessages } from "@/hooks/use-scheduled-messages";
import { useMobileLayout } from "@/hooks/use-mobile-layout";
import { usePageVisible } from "@/hooks/use-page-visible";
import { TimeZoneProvider, useReportedTimeZone } from "@/hooks/use-time-zone";
import { useWorkspaceController } from "@/features/workspace/use-workspace-controller";
import { effectiveTimeZone } from "@/lib/app-preferences";
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT } from "@/lib/layout";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import type { PluginId } from "../shared/plugins";

export default function App() {
  const userProfile = useUserProfile();
  const setup = useSetupGate(userProfile);
  if (setup.phase === "checking") return <SetupStatus />;
  if (setup.phase === "error") return <SetupStatus message={setup.message} onRetry={setup.retry} />;
  if (setup.phase === "onboarding") {
    return <Onboarding required={setup.required} userProfile={userProfile} onComplete={setup.complete} />;
  }
  return <Workspace userProfile={userProfile} />;
}

function Workspace({ userProfile }: { userProfile: UserProfileController }) {
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  const sidebarPanel = useResizablePanel({
    ...SIDEBAR_LAYOUT.resize,
    enabled: !mobile && !sidebarCollapsed,
  });
  const detailsPanel = useResizablePanel({
    ...DETAILS_LAYOUT.resize,
    enabled: !mobile && detailsOpen && Boolean(workspace.activeChat),
  });

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
  const activeChatShown = pageVisible && (!mobile || (mobilePage === "chat" && !detailsOpen));
  const activeChatUnread = Boolean(workspace.activeChat?.unread);
  const { markActiveChatRead } = workspace;
  useEffect(() => {
    if (activeChatShown && activeChatUnread) markActiveChatRead();
  }, [activeChatShown, activeChatUnread, markActiveChatRead]);

  function selectChat(chatId: string) {
    navigationVersion.current += 1;
    workspace.selectChat(chatId);
    if (mobile) setDetailsOpen(false);
    setMobilePage("chat");
  }

  function selectMessage(chatId: string, messageId: string) {
    navigationVersion.current += 1;
    workspace.selectMessage(chatId, messageId);
    if (mobile) setDetailsOpen(false);
    setMobilePage("chat");
  }

  function showConversations() {
    navigationVersion.current += 1;
    setDetailsOpen(false);
    setMobilePage("list");
  }

  function showApprovals() {
    navigationVersion.current += 1;
    setDetailsOpen(false);
    setMobilePage("approvals");
  }

  function showDetails(open: boolean) {
    navigationVersion.current += 1;
    setDetailsOpen(open);
  }

  function showSettings(section: SettingsEntrySection, pluginId?: PluginId, storageConversationId?: string) {
    navigationVersion.current += 1;
    settingsDialog.current?.open(section, pluginId, storageConversationId);
  }

  function showSearch(open: boolean) {
    navigationVersion.current += 1;
    setSearchOpen(open);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        navigationVersion.current += 1;
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <TimeZoneProvider timeZone={timeZone}>
      <TooltipProvider delay={300}>
        <div className="workspace-shell relative flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
          <Sidebar
            activeChatId={workspace.activeChatId}
            chats={workspace.chats}
            collapsed={sidebarCollapsed}
            currentUser={currentUser}
            width={sidebarPanel.width}
            mobile={mobile}
            hidden={mobile && (mobilePage !== "list" || detailsOpen)}
            statuses={workspace.statuses}
            approvals={workspace.approvals}
            failedChats={workspace.failedChats}
            loading={workspace.loading}
            error={workspace.error}
            onCollapsedChange={setSidebarCollapsed}
            onCreate={async (wisp, options) => {
              const created = await workspace.createWisp(wisp, options);
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
            onResizeStart={sidebarPanel.onResizeStart}
            onSelectChat={selectChat}
          />
          {workspace.activeChat ? (
            <ChatPanel
              hidden={mobile && (mobilePage !== "chat" || detailsOpen)}
              onBack={mobile ? showConversations : undefined}
              chat={workspace.activeChat}
              transcript={workspace.activeTranscript}
              status={workspace.statuses[workspace.activeChat.id] ?? "configuration_required"}
              activity={workspace.activity[workspace.activeChat.id]}
              error={workspace.conversationErrors[workspace.activeChat.id]?.message}
              acknowledging={Boolean(workspace.acknowledging[workspace.activeChat.id])}
              approvals={workspace.approvals[workspace.activeChat.id] ?? []}
              allowAlwaysAvailable={workspace.preferences.autoReview}
              onAnswerPrompt={(messageId, answer) => void workspace.answerPrompt(messageId, answer)}
              onAbort={() => void workspace.abortActiveChat()}
              onLoadOlder={workspace.loadOlderMessages}
              onLoadNewer={workspace.loadNewerMessages}
              onShowLatest={workspace.showLatestMessages}
              onOpenDetails={() => showDetails(true)}
              onConfigure={() => showSettings("model")}
              voice={{
                deviceId: workspace.preferences.microphone,
                providerId: workspace.preferences.voiceProvider,
                modelId: workspace.preferences.voiceModel,
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
            />
          ) : (
            <main hidden={mobile} className={cn(mainPanel, "items-center justify-center text-dim", mobile && "hidden")}>
              {workspace.loading ? "Loading conversations…" : (workspace.error ?? "Create a Wisp to get started.")}
            </main>
          )}
          {detailsOpen && workspace.activeChat ? (
            <DetailsPanel
              mobile={mobile}
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
              onDelete={async () => {
                const startedAt = navigationVersion.current;
                const deleted = await workspace.deleteActiveChat();
                if (deleted && startedAt === navigationVersion.current) showConversations();
              }}
              onResizeStart={detailsPanel.onResizeStart}
            />
          ) : null}
          {mobile && mobilePage === "approvals" ? (
            <MobileApprovals
              chats={workspace.chats}
              approvals={workspace.approvals}
              allowAlwaysAvailable={workspace.preferences.autoReview}
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
          userProfile={userProfile}
          preferences={workspace.preferences}
          persistenceStatus={workspace.persistenceStatus}
          persistenceError={workspace.persistenceError}
          onPreferencesChange={workspace.updatePreferences}
        />
        <UpdateToast displayName={APP_METADATA.displayName} />
      </TooltipProvider>
    </TimeZoneProvider>
  );
}
