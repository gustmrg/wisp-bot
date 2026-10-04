import { useEffect, useRef, useState } from "react";

import { AppSettingsDialogHost } from "@/components/app-settings-dialog-host";
import type { AppSettingsDialogHandle } from "@/components/app-settings-dialog-host";
import { ChatPanel } from "@/components/chat-panel";
import { DetailsPanel } from "@/components/details-panel";
import { SearchDialog } from "@/components/search-dialog";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_METADATA } from "@/config/app-metadata";
import { Onboarding, SetupStatus } from "@/components/onboarding";
import { useSetupGate } from "@/hooks/use-setup-gate";
import { useUserProfile, type UserProfileController } from "@/hooks/use-user-profile";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useMobileLayout } from "@/hooks/use-mobile-layout";
import { useWorkspaceController } from "@/features/workspace/use-workspace-controller";
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT } from "@/lib/layout";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

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
  const [mobilePage, setMobilePage] = useState<"list" | "chat">("list");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const settingsDialog = useRef<AppSettingsDialogHandle>(null);
  const navigationVersion = useRef(0);
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
      setMobilePage("list");
    }
  }, [workspace.activeChat]);

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

  function showDetails(open: boolean) {
    navigationVersion.current += 1;
    setDetailsOpen(open);
  }

  function showSettings(section: "general" | "model") {
    navigationVersion.current += 1;
    settingsDialog.current?.open(section);
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
    <TooltipProvider delay={300}>
      <div className="workspace-shell relative flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
        <Sidebar
          activeChatId={workspace.activeChatId}
          chats={workspace.chats}
          collapsed={sidebarCollapsed}
          currentUser={currentUser}
          width={sidebarPanel.width}
          mobile={mobile}
          hidden={mobile && (mobilePage === "chat" || detailsOpen)}
          statuses={workspace.statuses}
          approvals={workspace.approvals}
          loading={workspace.loading}
          error={workspace.error}
          onCollapsedChange={setSidebarCollapsed}
          onCreate={async (chat, model) => {
            const created = await workspace.createChat(chat, model);
            if (created) {
              navigationVersion.current += 1;
              if (mobile) setDetailsOpen(false);
              setMobilePage("chat");
            }
            return created;
          }}
          onOpenSearch={() => showSearch(true)}
          onOpenSettings={() => showSettings("general")}
          onResizeStart={sidebarPanel.onResizeStart}
          onSelectChat={selectChat}
        />
        {workspace.activeChat ? (
          <ChatPanel
            hidden={mobile && (mobilePage === "list" || detailsOpen)}
            onBack={mobile ? showConversations : undefined}
            chat={workspace.activeChat}
            chats={workspace.chats}
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
            onRetry={(messageId) => void workspace.retryMessage(messageId)}
            onResolveApproval={(request, decision) => void workspace.resolveApproval(request, decision)}
            onSend={(text) => void workspace.sendMessage(text)}
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
            chats={workspace.chats}
            width={detailsPanel.width}
            onChange={workspace.updateActiveChat}
            onClose={() => showDetails(false)}
            onDelete={async () => {
              const startedAt = navigationVersion.current;
              const deleted = await workspace.deleteActiveChat();
              if (deleted && startedAt === navigationVersion.current) showConversations();
            }}
            onResizeStart={detailsPanel.onResizeStart}
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
        userProfile={userProfile}
        preferences={workspace.preferences}
        persistenceStatus={workspace.persistenceStatus}
        persistenceError={workspace.persistenceError}
        onPreferencesChange={workspace.updatePreferences}
      />
    </TooltipProvider>
  );
}
