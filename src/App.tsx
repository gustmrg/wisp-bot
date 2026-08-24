import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { ChatPanel } from "@/components/chat-panel";
import {
  CreateAgentDialog,
  type NewAgent,
} from "@/components/create-agent-dialog";
import { Sidebar } from "@/components/sidebar";
import { ModelSettingsDialog } from "@/components/model-settings-dialog";
import { DEFAULT_MODEL_DEFAULTS, type ModelDefaults } from "@/components/model-options";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  initialChats,
  type ChatCollection,
  type ChatId,
  type Message,
} from "./chat-data";

function appendMessage(
  chats: ChatCollection,
  chatId: ChatId,
  message: Message,
): ChatCollection {
  const chat = chats[chatId];

  if (!chat) {
    return chats;
  }

  return {
    ...chats,
    [chatId]: {
      ...chat,
      messages: [...chat.messages, message],
    },
  };
}

function uniqueAgentId(name: string, chats: ChatCollection): ChatId {
  const baseId =
    name
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "agent";
  let id = baseId;
  let suffix = 2;

  while (chats[id]) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return id;
}

export default function App() {
  const [chats, setChats] = useState<ChatCollection>(initialChats);
  const [activeChatId, setActiveChatId] = useState<ChatId>("chief");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modelDefaults, setModelDefaults] = useState<ModelDefaults>(DEFAULT_MODEL_DEFAULTS);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const replyTimersRef = useRef<Set<number>>(new Set());
  const activeChat = chats[activeChatId];
  const chatIds = Object.keys(chats);

  useEffect(
    () => () => {
      replyTimersRef.current.forEach(window.clearTimeout);
    },
    [],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const messageText = draft.trim();

    if (!messageText) {
      return;
    }

    const chatId = activeChatId;
    setChats((currentChats) =>
      appendMessage(currentChats, chatId, {
        type: "outgoing",
        text: messageText,
      }),
    );
    setDraft("");

    const timer = window.setTimeout(() => {
      setChats((currentChats) =>
        appendMessage(currentChats, chatId, {
          type: "incoming",
          text: "on it — i'll report back when it's done.",
        }),
      );
      replyTimersRef.current.delete(timer);
    }, 700);

    replyTimersRef.current.add(timer);
  }

  function handleCreateAgent(agent: NewAgent) {
    const id = uniqueAgentId(agent.name, chats);
    const preview = agent.description || "Ready for the first task.";

    setChats((currentChats) => ({
      ...currentChats,
      [id]: {
        ...agent,
        id,
        messages: [],
        preview,
        timestamp: "Now",
      },
    }));
    setActiveChatId(id);
    setQuery("");
    setDraft("");
  }

  return (
    <TooltipProvider delay={300}>
      <div className="window">
        <div className="body">
          <Sidebar
            activeChatId={activeChatId}
            chatIds={chatIds}
            chats={chats}
            collapsed={sidebarCollapsed}
            createAgentAction={
              <CreateAgentDialog
                compact={sidebarCollapsed}
                defaults={modelDefaults}
                onCreate={handleCreateAgent}
              />
            }
            settingsAction={<ModelSettingsDialog defaults={modelDefaults} onSave={setModelDefaults} />}
            query={query}
            onCollapsedChange={setSidebarCollapsed}
            onQueryChange={setQuery}
            onSelectChat={setActiveChatId}
          />
          {activeChat ? (
            <ChatPanel
              chat={activeChat}
              draft={draft}
              composerInputRef={composerInputRef}
              onDraftChange={setDraft}
              onSubmit={handleSubmit}
            />
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
