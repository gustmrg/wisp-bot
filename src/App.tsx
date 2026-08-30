import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, FormEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";

import type { AgentSettings, ChatCollection, ChatId, Message } from "@/chat-data";
import { initialChats } from "@/chat-data";
import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { ChatPanel } from "@/components/chat-panel";
import type { NewAgent } from "@/components/create-agent-dialog";
import { DetailsPanel } from "@/components/details-panel";
import { SearchDialog } from "@/components/search-dialog";
import { Sidebar } from "@/components/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme } from "@/lib/theme";
import { DEFAULT_PREFERENCES, normalizePreferences, type AppPreferences } from "@/lib/app-preferences";
import { migrateLegacyChats } from "@/lib/circle-members";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "wisp-bot-ui-v2";

interface PersistedState {
  chats: ChatCollection;
  preferences: AppPreferences;
}

function loadState(): PersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PersistedState>;
      if (saved.chats && Object.keys(saved.chats).length) {
        return { chats: migrateLegacyChats(saved.chats), preferences: normalizePreferences(saved.preferences) };
      }
    }
  } catch {
    // A corrupt mock state should never prevent the desktop UI from opening.
  }
  return { chats: initialChats, preferences: DEFAULT_PREFERENCES };
}

function appendMessage(chats: ChatCollection, chatId: ChatId, message: Message): ChatCollection {
  const chat = chats[chatId];
  if (!chat) return chats;
  return {
    ...chats,
    [chatId]: {
      ...chat,
      messages: [...chat.messages, message],
      preview: "text" in message ? message.text : chat.preview,
      timestamp: "Now",
    },
  };
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
  const [savedState] = useState(loadState);
  const [chats, setChats] = useState<ChatCollection>(savedState.chats);
  const [preferences, setPreferences] = useState<AppPreferences>(savedState.preferences);
  const [activeChatId, setActiveChatId] = useState<ChatId>(() => savedState.chats.chief ? "chief" : Object.keys(savedState.chats)[0] ?? "");
  const [draft, setDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [detailsWidth, setDetailsWidth] = useState(318);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workingChatId, setWorkingChatId] = useState<ChatId | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const replyTimersRef = useRef<Set<number>>(new Set());
  const activeChat = chats[activeChatId];

  useLayoutEffect(() => applyTheme(preferences.theme), [preferences.theme]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats, preferences } satisfies PersistedState));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [chats, preferences]);

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

  useEffect(() => () => replyTimersRef.current.forEach(window.clearTimeout), []);

  function handleSelectChat(chatId: ChatId) {
    setActiveChatId(chatId);
    setDraft("");
    setChats((current) => {
      const chat = current[chatId];
      return chat?.unread ? { ...current, [chatId]: { ...chat, unread: false } } : current;
    });
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeChat) return;

    const chatId = activeChat.id;
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    setChats((current) => appendMessage(current, chatId, { type: "outgoing", text, time }));
    setDraft("");
    setWorkingChatId(chatId);

    const timer = window.setTimeout(() => {
      setChats((current) => appendMessage(current, chatId, {
        type: "incoming",
        text: "On it. I’ll line up the pieces and pull you in if anything needs a decision.",
        time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      }));
      setWorkingChatId((current) => current === chatId ? null : current);
      replyTimersRef.current.delete(timer);
    }, 1100);
    replyTimersRef.current.add(timer);
  }

  function handleCreateAgent(agent: NewAgent) {
    const id = uniqueAgentId(agent.name, chats);
    setChats((current) => ({
      ...current,
      [id]: {
        ...agent,
        id,
        isActive: !agent.isCircle,
        preview: agent.isCircle ? "This is the beginning of the circle." : "Ready for the first task.",
        timestamp: "Now",
        messages: agent.isCircle
          ? [{ type: "time", text: "This is the beginning of the circle" }]
          : [],
      },
    }));
    setActiveChatId(id);
    if (!agent.isCircle) {
      setWorkingChatId(id);
      const timer = window.setTimeout(() => {
        setChats((current) => appendMessage(current, id, {
          type: "incoming",
          text: `Hey John, I'm here. What do you want me on first?`,
          time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        }));
        setWorkingChatId((current) => current === id ? null : current);
        replyTimersRef.current.delete(timer);
      }, 1400);
      replyTimersRef.current.add(timer);
    }
  }

  function handleUpdateChat(changes: Partial<AgentSettings>) {
    setChats((current) => {
      const chat = current[activeChatId];
      return chat ? { ...current, [activeChatId]: { ...chat, ...changes } } : current;
    });
  }

  function handleDeleteChat() {
    setChats((current) => {
      const next = { ...current };
      delete next[activeChatId];
      const nextId = Object.keys(next)[0] ?? "";
      setActiveChatId(nextId);
      return next;
    });
    setDetailsOpen(false);
  }

  function handleAnswerPrompt(messageIndex: number, answer: string) {
    setChats((current) => {
      const chat = current[activeChatId];
      if (!chat) return current;
      const messages = chat.messages.map((message, index) => index === messageIndex && message.type === "prompt" ? { ...message, answer } : message);
      return { ...current, [activeChatId]: { ...chat, messages } };
    });
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
        ) : <main className={cn(mainPanel, "items-center justify-center text-dim")}>Create a Wisp to get started.</main>}
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
