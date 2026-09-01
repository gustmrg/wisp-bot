import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import type { AgentSettings, ChatCollection, ChatId } from "@/chat-data";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../shared/tool-policy";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { ChatPanel } from "@/components/chat-panel";
import type { NewAgent } from "@/components/create-agent-dialog";
import { DetailsPanel } from "@/components/details-panel";
import { SearchDialog } from "@/components/search-dialog";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_METADATA } from "@/config/app-metadata";
import { DEMO_CURRENT_USER } from "@/fixtures/demo-session";
import { applyTheme } from "@/lib/theme";
import { DEFAULT_PREFERENCES, normalizePreferences, type AppPreferences } from "@/lib/app-preferences";
import { LEGACY_STORAGE_KEY, useConversations } from "@/hooks/use-conversations";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT } from "@/lib/layout";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

const PREFERENCES_STORAGE_KEY = "wisp-bot-preferences-v1";

function loadPreferences(): AppPreferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (raw) return normalizePreferences(JSON.parse(raw));
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) return normalizePreferences((JSON.parse(legacy) as { preferences?: AppPreferences }).preferences);
  } catch {
    // Invalid renderer preferences should not prevent the desktop UI from opening.
  }
  return DEFAULT_PREFERENCES;
}

function uniqueAgentId(name: string, chats: ChatCollection): ChatId {
  const baseId =
    name
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "wisp";
  let id = baseId;
  let suffix = 2;
  while (chats[id]) id = `${baseId}-${suffix++}`;
  return id;
}

export default function App() {
  const conversations = useConversations();
  const chats = conversations.chats;
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [toolPolicyLoaded, setToolPolicyLoaded] = useState(false);
  const [activeChatId, setActiveChatId] = useState<ChatId>("");
  const [draft, setDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const activeChat = chats[activeChatId];
  const sidebarPanel = useResizablePanel({ ...SIDEBAR_LAYOUT.resize, enabled: !sidebarCollapsed });
  const detailsPanel = useResizablePanel({ ...DETAILS_LAYOUT.resize, enabled: detailsOpen && Boolean(activeChat) });

  useLayoutEffect(() => {
    applyTheme(preferences.theme);
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    let cancelled = false;
    void window.wisp.getToolPolicy().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setPreferences((current) => {
          const backendIsDefault = result.value.autoReview && result.value.rules.length === 0;
          const localHasPolicy = !current.autoReview || current.autoReviewRules.length > 0;
          if (backendIsDefault && localHasPolicy) return current;
          return {
            ...current,
            autoReview: result.value.autoReview,
            autoReviewRules: [...result.value.rules],
          };
        });
      }
      setToolPolicyLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toolPolicyLoaded) return;
    void window.wisp.saveToolPolicy({
      autoReview: preferences.autoReview,
      rules: preferences.autoReviewRules,
    });
  }, [preferences.autoReview, preferences.autoReviewRules, toolPolicyLoaded]);

  useEffect(() => {
    if (!chats[activeChatId]) {
      setActiveChatId(chats.chief ? "chief" : (Object.keys(chats)[0] ?? ""));
    }
  }, [activeChatId, chats]);

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

  function handleSelectChat(chatId: ChatId) {
    setActiveChatId(chatId);
    setDraft("");
    if (chats[chatId]?.unread) void conversations.markRead(chatId);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeChat) return;

    setDraft("");
    void conversations.sendMessage(activeChat.id, text);
  }

  function handleCreateAgent(agent: NewAgent) {
    const id = uniqueAgentId(agent.name, chats);
    void (async () => {
      const created = await conversations.create({
        ...agent,
        id,
        isActive: !agent.isCircle,
        preview: agent.isCircle ? "This is the beginning of the circle." : "Ready for the first task.",
        timestamp: "Now",
        messages: agent.isCircle
          ? [{ id: crypto.randomUUID(), status: "complete", type: "time", text: "This is the beginning of the circle" }]
          : [],
      });
      if (!created) return;
      setActiveChatId(id);
    })();
  }

  function handleUpdateChat(changes: Partial<AgentSettings>) {
    if (activeChatId) void conversations.update(activeChatId, changes);
  }

  function handleDeleteChat() {
    if (activeChatId) {
      void conversations.delete(activeChatId);
    }
    setDetailsOpen(false);
  }

  function handleAnswerPrompt(messageId: string | undefined, answer: string) {
    if (activeChatId && messageId) void conversations.answerPrompt(activeChatId, messageId, answer);
  }

  function handleRetry(messageId: string | undefined) {
    if (!activeChatId || !messageId?.endsWith(":assistant")) return;
    void conversations.retryMessage(activeChatId, messageId.slice(0, -":assistant".length));
  }

  async function handleResolveApproval(request: ToolApprovalRequest, decision: ToolApprovalDecision) {
    const resolved = await conversations.resolveApproval(request, decision);
    if (!resolved || decision !== "block") return;
    const policy = await window.wisp.getToolPolicy();
    if (policy.ok) {
      setPreferences((current) => ({
        ...current,
        autoReview: policy.value.autoReview,
        autoReviewRules: [...policy.value.rules],
      }));
    }
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
        <Sidebar
          activeChatId={activeChatId}
          chats={chats}
          collapsed={sidebarCollapsed}
          currentUser={DEMO_CURRENT_USER}
          width={sidebarPanel.width}
          onCollapsedChange={setSidebarCollapsed}
          onCreate={handleCreateAgent}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onResizeStart={sidebarPanel.onResizeStart}
          onSelectChat={handleSelectChat}
        />
        {activeChat ? (
          <ChatPanel
            chat={activeChat}
            chats={chats}
            draft={draft}
            composerInputRef={composerInputRef}
            status={conversations.statuses[activeChat.id] ?? "configuration_required"}
            activity={conversations.activity[activeChat.id]}
            error={conversations.conversationErrors[activeChat.id]?.message}
            acknowledging={Boolean(conversations.acknowledging[activeChat.id])}
            approvals={conversations.approvals[activeChat.id] ?? []}
            toolActivities={conversations.toolActivities[activeChat.id] ?? []}
            onAnswerPrompt={handleAnswerPrompt}
            onAbort={() => void conversations.abort(activeChat.id)}
            onDraftChange={setDraft}
            onOpenDetails={() => setDetailsOpen(true)}
            onRetry={handleRetry}
            onResolveApproval={(request, decision) => void handleResolveApproval(request, decision)}
            onSubmit={handleSubmit}
          />
        ) : (
          <main className={cn(mainPanel, "items-center justify-center text-dim")}>
            {conversations.loading
              ? "Loading conversations…"
              : (conversations.error ?? "Create a Wisp to get started.")}
          </main>
        )}
        {detailsOpen && activeChat ? (
          <DetailsPanel
            chat={activeChat}
            chats={chats}
            width={detailsPanel.width}
            onChange={handleUpdateChat}
            onClose={() => setDetailsOpen(false)}
            onDelete={handleDeleteChat}
            onResizeStart={detailsPanel.onResizeStart}
          />
        ) : null}
      </div>
      <SearchDialog chats={chats} open={searchOpen} onOpenChange={setSearchOpen} onSelectChat={handleSelectChat} />
      <AppSettingsDialog
        appMetadata={APP_METADATA}
        currentUser={DEMO_CURRENT_USER}
        open={settingsOpen}
        preferences={preferences}
        onOpenChange={setSettingsOpen}
        onPreferencesChange={setPreferences}
      />
    </TooltipProvider>
  );
}
