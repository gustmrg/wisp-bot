import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, FormEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";

import type { AgentSettings, ChatCollection, ChatId } from "@/chat-data";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { ChatPanel } from "@/components/chat-panel";
import type { NewAgent } from "@/components/create-agent-dialog";
import { DetailsPanel } from "@/components/details-panel";
import { SearchDialog } from "@/components/search-dialog";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme } from "@/lib/theme";
import { DEFAULT_PREFERENCES, normalizePreferences, type AppPreferences } from "@/lib/app-preferences";
import { LEGACY_STORAGE_KEY, useConversations } from "@/hooks/use-conversations";
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
  const baseId = name.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "wisp";
  let id = baseId;
  let suffix = 2;
  while (chats[id]) id = `${baseId}-${suffix++}`;
  return id;
}

function startResize(
  event: ReactPointerEvent<HTMLDivElement>,
  current: number,
  setValue: Dispatch<SetStateAction<number>>,
  direction: 1 | -1,
  min: number,
  max: number,
) {
  event.preventDefault();
  const startX = event.clientX;
  const move = (moveEvent: PointerEvent) => setValue(Math.min(max, Math.max(min, current + ((moveEvent.clientX - startX) * direction))));
  const stop = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
    document.body.classList.remove("resizing");
  };
  document.body.classList.add("resizing");
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", stop);
}

export default function App() {
  const conversations = useConversations();
  const chats = conversations.chats;
  const [preferences, setPreferences] = useState<AppPreferences>(loadPreferences);
  const [activeChatId, setActiveChatId] = useState<ChatId>("");
  const [draft, setDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [detailsWidth, setDetailsWidth] = useState(318);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workingChatId, setWorkingChatId] = useState<ChatId | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const replyTimersRef = useRef<Map<number, ChatId>>(new Map());
  const activeChat = chats[activeChatId];

  useLayoutEffect(() => {
    applyTheme(preferences.theme);
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    if (!chats[activeChatId]) {
      setActiveChatId(chats.chief ? "chief" : Object.keys(chats)[0] ?? "");
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

  useEffect(() => () => replyTimersRef.current.forEach((_chatId, timer) => window.clearTimeout(timer)), []);

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

    const chatId = activeChat.id;
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    void conversations.appendMessage(chatId, {
      id: crypto.randomUUID(),
      status: "complete",
      type: "outgoing",
      text,
      time,
    });
    setDraft("");
    setWorkingChatId(chatId);

    const timer = window.setTimeout(() => {
      void conversations.appendMessage(chatId, {
        id: crypto.randomUUID(),
        status: "complete",
        type: "incoming",
        text: "On it. I’ll line up the pieces and pull you in if anything needs a decision.",
        time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      });
      setWorkingChatId((current) => current === chatId ? null : current);
      replyTimersRef.current.delete(timer);
    }, 1100);
    replyTimersRef.current.set(timer, chatId);
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
      if (!agent.isCircle) {
        setWorkingChatId(id);
        const timer = window.setTimeout(() => {
          void conversations.appendMessage(id, {
            id: crypto.randomUUID(),
            status: "complete",
            type: "incoming",
            text: `Hey John, I'm here. What do you want me on first?`,
            time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
          });
          setWorkingChatId((current) => current === id ? null : current);
          replyTimersRef.current.delete(timer);
        }, 1400);
        replyTimersRef.current.set(timer, id);
      }
    })();
  }

  function handleUpdateChat(changes: Partial<AgentSettings>) {
    if (activeChatId) void conversations.update(activeChatId, changes);
  }

  function handleDeleteChat() {
    if (activeChatId) {
      for (const [timer, chatId] of replyTimersRef.current) {
        if (chatId === activeChatId) {
          window.clearTimeout(timer);
          replyTimersRef.current.delete(timer);
        }
      }
      setWorkingChatId((current) => current === activeChatId ? null : current);
      void conversations.delete(activeChatId);
    }
    setDetailsOpen(false);
  }

  function handleAnswerPrompt(messageId: string | undefined, answer: string) {
    if (activeChatId && messageId) void conversations.answerPrompt(activeChatId, messageId, answer);
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
        <Sidebar
          activeChatId={activeChatId}
          chats={chats}
          collapsed={sidebarCollapsed}
          width={sidebarWidth}
          onCollapsedChange={setSidebarCollapsed}
          onCreate={handleCreateAgent}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onResizeStart={(event) => startResize(event, sidebarWidth, setSidebarWidth, 1, 220, 400)}
          onSelectChat={handleSelectChat}
        />
        {activeChat ? (
          <ChatPanel
            chat={activeChat}
            chats={chats}
            draft={draft}
            composerInputRef={composerInputRef}
            working={workingChatId === activeChat.id}
            onAnswerPrompt={handleAnswerPrompt}
            onDraftChange={setDraft}
            onOpenDetails={() => setDetailsOpen(true)}
            onSubmit={handleSubmit}
          />
        ) : <main className={cn(mainPanel, "items-center justify-center text-dim")}>
          {conversations.loading ? "Loading conversations…" : conversations.error ?? "Create a Wisp to get started."}
        </main>}
        {detailsOpen && activeChat ? (
          <DetailsPanel
            chat={activeChat}
            chats={chats}
            width={detailsWidth}
            onChange={handleUpdateChat}
            onClose={() => setDetailsOpen(false)}
            onDelete={handleDeleteChat}
            onResizeStart={(event) => startResize(event, detailsWidth, setDetailsWidth, -1, 280, 480)}
          />
        ) : null}
      </div>
      <SearchDialog chats={chats} open={searchOpen} onOpenChange={setSearchOpen} onSelectChat={handleSelectChat} />
      <AppSettingsDialog open={settingsOpen} preferences={preferences} onOpenChange={setSettingsOpen} onPreferencesChange={setPreferences} />
    </TooltipProvider>
  );
}
