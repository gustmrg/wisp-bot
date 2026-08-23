import { useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  chatOrder,
  initialChats,
  type Chat,
  type ChatCollection,
  type ChatId,
  type Message,
} from "./chat-data";

interface AvatarProps {
  chat: Chat;
  small?: boolean;
}

function Avatar({ chat, small = false }: AvatarProps) {
  const className = `avatar${small ? " sm" : ""} ${chat.avatarClass}`;

  return (
    <span className={className} aria-hidden="true">
      {chat.id === "offsite" ? (
        <>
          <span />
          <span />
          <span />
        </>
      ) : (
        chat.avatarText
      )}
    </span>
  );
}

interface SidebarProps {
  activeChatId: ChatId;
  chats: ChatCollection;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectChat: (chatId: ChatId) => void;
}

function Sidebar({
  activeChatId,
  chats,
  query,
  onQueryChange,
  onSelectChat,
}: SidebarProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleChatIds = chatOrder.filter((chatId) =>
    chats[chatId].name.toLocaleLowerCase().includes(normalizedQuery),
  );

  return (
    <aside className="sidebar">
      <label className="search">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          type="search"
          aria-label="Search chats"
          placeholder="Search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>

      <nav className="chat-list" aria-label="Chats">
        {visibleChatIds.map((chatId) => {
          const chat = chats[chatId];

          return (
            <button
              className={`chat-item${chatId === activeChatId ? " active" : ""}`}
              type="button"
              aria-current={chatId === activeChatId ? "page" : undefined}
              key={chatId}
              onClick={() => onSelectChat(chatId)}
            >
              <Avatar chat={chat} />
              <span className="item-text">
                <span className="item-top">
                  <span className="name">{chat.name}</span>
                  <span className="time">{chat.timestamp}</span>
                </span>
                <span className="preview">{chat.preview}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="profile">
        <span className="profile-avatar">AS</span>
        <span>Armand Segall</span>
      </div>
    </aside>
  );
}

interface MessageViewProps {
  message: Message;
}

function MessageView({ message }: MessageViewProps) {
  if (message.type === "time") {
    return <div className="time-divider">{message.text}</div>;
  }

  if (message.type === "card") {
    return (
      <div className="card">
        <ul>
          {message.items.map((item) => (
            <li key={item.label}>
              <span className="check">✓</span>
              <div>
                <strong>{item.label}</strong> → {item.text}
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={`msg ${message.type === "incoming" ? "in" : "out"}`}>
      {message.text}
      {message.reaction ? <span className="reaction">{message.reaction}</span> : null}
    </div>
  );
}

interface ChatPanelProps {
  chat: Chat;
  draft: string;
  composerInputRef: RefObject<HTMLInputElement | null>;
  messagesRef: RefObject<HTMLElement | null>;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ChatPanel({
  chat,
  draft,
  composerInputRef,
  messagesRef,
  onDraftChange,
  onSubmit,
}: ChatPanelProps) {
  return (
    <main className="main">
      <header className="chat-header">
        <Avatar chat={chat} small />
        <h1>{chat.name}</h1>
      </header>

      <section className="messages" ref={messagesRef} aria-live="polite">
        {chat.messages.map((message, index) => (
          <MessageView message={message} key={`${message.type}-${index}`} />
        ))}
      </section>

      <form className="composer" onSubmit={onSubmit}>
        <Button
          variant="outline"
          size="icon"
          type="button"
          className="plus"
          aria-label="Add attachment"
          onClick={() => composerInputRef.current?.focus()}
        >
          +
        </Button>
        <input
          ref={composerInputRef}
          type="text"
          aria-label={`Message ${chat.name}`}
          placeholder={`Message ${chat.name}`}
          autoComplete="off"
          value={draft}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
        />
        <Button type="submit" size="icon" className="mic" aria-label="Send message">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </Button>
      </form>
    </main>
  );
}

function appendMessage(
  chats: ChatCollection,
  chatId: ChatId,
  message: Message,
): ChatCollection {
  const chat = chats[chatId];

  return {
    ...chats,
    [chatId]: {
      ...chat,
      messages: [...chat.messages, message],
    },
  };
}

export default function App() {
  const [chats, setChats] = useState<ChatCollection>(initialChats);
  const [activeChatId, setActiveChatId] = useState<ChatId>("chief");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const composerInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLElement>(null);
  const replyTimersRef = useRef<Set<number>>(new Set());
  const activeChat = chats[activeChatId];

  useEffect(() => {
    const messagesElement = messagesRef.current;

    if (messagesElement) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
  }, [activeChatId, activeChat.messages.length]);

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

  return (
    <div className="window">
      <header className="titlebar">
        <div className="traffic-lights" aria-hidden="true">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="icon-btn plus-btn"
          type="button"
          aria-label="New chat"
          onClick={() => composerInputRef.current?.focus()}
        >
          +
        </Button>
        <div className="spacer" />
        <Button
          variant="ghost"
          size="icon-sm"
          className="icon-btn"
          type="button"
          aria-label="Open in window"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M9 21h6M12 17v4" />
          </svg>
        </Button>
      </header>

      <div className="body">
        <Sidebar
          activeChatId={activeChatId}
          chats={chats}
          query={query}
          onQueryChange={setQuery}
          onSelectChat={setActiveChatId}
        />
        <ChatPanel
          chat={activeChat}
          draft={draft}
          composerInputRef={composerInputRef}
          messagesRef={messagesRef}
          onDraftChange={setDraft}
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
}
