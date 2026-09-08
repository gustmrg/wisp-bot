import { useBackend } from "@/features/backend/backend-provider";
import { useNarrowScreen } from "@/hooks/use-narrow-screen";
import { useEffect, useState } from "react";

import { useConversationModel, modelName } from "@/hooks/use-conversation-model";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { ChatPanel } from "@/components/chat-panel";
import { DetailsPanel } from "@/components/details-panel";
import { SearchDialog } from "@/components/search-dialog";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_METADATA } from "@/config/app-metadata";
import { DEMO_CURRENT_USER } from "@/fixtures/demo-session";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useWorkspaceController } from "@/features/workspace/use-workspace-controller";
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT } from "@/lib/layout";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

export default function App({
  onOpenConnections,
  connectionLabel,
  connectionMessage,
}: {
  onOpenConnections?: () => void;
  connectionLabel?: string;
  connectionMessage?: string;
} = {}) {
  const backend = useBackend();
  const narrow = useNarrowScreen();
  const [mobilePage, setMobilePage] = useState<"list" | "chat">("list");
  const currentUser = backend.owner ?? DEMO_CURRENT_USER;
  const workspace = useWorkspaceController();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "model" | null>(null);
  const conversationModel = useConversationModel(
    workspace.activeChat?.kind === "wisp" ? workspace.activeChat.id : null,
  );
  const sidebarPanel = useResizablePanel({ ...SIDEBAR_LAYOUT.resize, enabled: !sidebarCollapsed });
  const detailsPanel = useResizablePanel({
    ...DETAILS_LAYOUT.resize,
    enabled: detailsOpen && Boolean(workspace.activeChat),
  });

  useEffect(() => {
    if (!workspace.activeChat) setDetailsOpen(false);
  }, [workspace.activeChat]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function back(event: Event) {
      if (settingsSection) setSettingsSection(null);
      else if (searchOpen) setSearchOpen(false);
      else if (detailsOpen) setDetailsOpen(false);
      else if (narrow && mobilePage === "chat") setMobilePage("list");
      else return;
      event.preventDefault();
    }
    document.addEventListener("wisp:back", back);
    return () => document.removeEventListener("wisp:back", back);
  }, [settingsSection, searchOpen, detailsOpen, narrow, mobilePage]);

  return (
    <TooltipProvider delay={300}>
      <div className="wisp-app flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
        {onOpenConnections ? (
          <header className="flex min-h-10 flex-none items-center justify-between gap-3 border-b border-border px-3">
            <button
              className="min-h-9 rounded-md px-2 text-left text-xs hover:bg-muted"
              onClick={onOpenConnections}
              type="button"
              aria-label="Manage connections"
            >
              {connectionLabel ?? "Connections"}
            </button>
            <span className="min-w-0 truncate text-xs text-dim" role="status">
              {connectionMessage}
            </span>
          </header>
        ) : null}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {!narrow || mobilePage === "list" ? (
            <Sidebar
              activeChatId={workspace.activeChatId}
              chats={workspace.chats}
              collapsed={narrow ? false : sidebarCollapsed}
              currentUser={currentUser}
              width={sidebarPanel.width}
              onCollapsedChange={setSidebarCollapsed}
              onCreate={(chat) => void workspace.createChat(chat)}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenSettings={() => setSettingsSection("general")}
              onResizeStart={sidebarPanel.onResizeStart}
              onSelectChat={(id) => {
                workspace.selectChat(id);
                setMobilePage("chat");
              }}
            />
          ) : null}
          {!narrow || mobilePage === "chat" ? (
            <>
              {workspace.activeChat ? (
                <ChatPanel
                  chat={workspace.activeChat}
                  chats={workspace.chats}
                  status={workspace.statuses[workspace.activeChat.id] ?? "configuration_required"}
                  activity={workspace.activity[workspace.activeChat.id]}
                  error={workspace.conversationErrors[workspace.activeChat.id]?.message ?? workspace.error ?? undefined}
                  acknowledging={Boolean(workspace.acknowledging[workspace.activeChat.id])}
                  approvals={workspace.approvals[workspace.activeChat.id] ?? []}
                  toolActivities={workspace.toolActivities[workspace.activeChat.id] ?? []}
                  onAnswerPrompt={(messageId, answer) => void workspace.answerPrompt(messageId, answer)}
                  onAbort={() => void workspace.abortActiveChat()}
                  onOpenDetails={() => setDetailsOpen(true)}
                  onConfigure={() => setSettingsSection("model")}
                  modelLabel={
                    conversationModel
                      ? `${modelName(conversationModel.applied)}${conversationModel.pending ? ` → ${modelName(conversationModel.pending)} (after this turn)` : ""}`
                      : undefined
                  }
                  onRetry={(messageId) => void workspace.retryMessage(messageId)}
                  onResolveApproval={(request, decision) => void workspace.resolveApproval(request, decision)}
                  onSend={workspace.sendMessage}
                  connected={backend.writable}
                  onLoadEarlier={workspace.loadEarlier}
                  hasEarlier={workspace.hasEarlier}
                  loadingHistory={workspace.loadingHistory}
                  historyError={workspace.historyError}
                  onBack={narrow ? () => setMobilePage("list") : undefined}
                />
              ) : (
                <main className={cn(mainPanel, "items-center justify-center text-dim")}>
                  {workspace.loading ? "Loading conversations…" : (workspace.error ?? "Create a Wisp to get started.")}
                </main>
              )}
            </>
          ) : null}
          {detailsOpen && workspace.activeChat ? (
            <DetailsPanel
              chat={workspace.activeChat}
              chats={workspace.chats}
              width={detailsPanel.width}
              onChange={workspace.updateActiveChat}
              onClose={() => setDetailsOpen(false)}
              onDelete={(revision) => void workspace.deleteActiveChat(revision)}
              onResizeStart={detailsPanel.onResizeStart}
            />
          ) : null}
        </div>
      </div>
      <SearchDialog
        chats={workspace.chats}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelectChat={(id) => {
          workspace.selectChat(id);
          setMobilePage("chat");
        }}
      />
      <AppSettingsDialog
        key={settingsSection ?? "closed"}
        initialSection={settingsSection ?? "general"}
        appMetadata={APP_METADATA}
        currentUser={currentUser}
        open={settingsSection !== null}
        preferences={workspace.preferences}
        persistenceStatus={workspace.persistenceStatus}
        persistenceError={workspace.persistenceError}
        onOpenChange={(open) => setSettingsSection(open ? "general" : null)}
        onPreferencesChange={workspace.updatePreferences}
      />
    </TooltipProvider>
  );
}
