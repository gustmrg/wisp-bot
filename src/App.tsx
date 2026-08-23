import { useEffect, useRef, useState } from "react";
import type { FormEvent, RefObject } from "react";
import {
  MonitorUpIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Bubble,
  BubbleContent,
  BubbleReactions,
} from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Message as MessageRow,
  MessageContent,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Separator } from "@/components/ui/separator";
import { Wisp } from "@/components/wisp";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  chatOrder,
  initialChats,
  type Chat,
  type ChatCollection,
  type ChatId,
  type Message,
} from "./chat-data";

interface ChatAvatarProps {
  chat: Chat;
  size?: "default" | "sm" | "lg";
}

function ChatAvatar({ chat, size = "default" }: ChatAvatarProps) {
  return <Wisp aria-hidden="true" name={chat.name} size={size} />;
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
      <InputGroup className="search">
        <InputGroupInput
          type="search"
          aria-label="Search chats"
          placeholder="Search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
      </InputGroup>

      <nav className="chat-list" aria-label="Chats">
        {visibleChatIds.length > 0 ? (
          <ItemGroup className="chat-items">
            {visibleChatIds.map((chatId) => {
              const chat = chats[chatId];
              const isActive = chatId === activeChatId;

              return (
                <Item
                  render={<button type="button" />}
                  className="chat-item"
                  variant={isActive ? "muted" : "default"}
                  size="sm"
                  aria-current={isActive ? "page" : undefined}
                  key={chatId}
                  onClick={() => onSelectChat(chatId)}
                >
                  <ItemMedia>
                    <ChatAvatar chat={chat} size="lg" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemHeader>
                      <ItemTitle className="min-w-0 flex-1 text-left">
                        <span className="truncate">{chat.name}</span>
                      </ItemTitle>
                      <span className="chat-time">{chat.timestamp}</span>
                    </ItemHeader>
                    <ItemDescription className="truncate">
                      {chat.preview}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              );
            })}
          </ItemGroup>
        ) : (
          <Empty className="chat-empty">
            <EmptyHeader>
              <EmptyTitle>No chats found</EmptyTitle>
              <EmptyDescription>Try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </nav>

      <Separator />
      <div className="profile">
        <Avatar size="sm" aria-hidden="true">
          <AvatarFallback>AS</AvatarFallback>
        </Avatar>
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
    return (
      <Marker className="justify-center py-2">
        <MarkerContent>{message.text}</MarkerContent>
      </Marker>
    );
  }

  if (message.type === "card") {
    return (
      <MessageRow align="start">
        <MessageContent>
          <Bubble variant="outline" align="start">
            <BubbleContent>
              <ul className="status-list">
                {message.items.map((item) => (
                  <li key={item.label}>
                    <span className="status-check" aria-hidden="true">
                      ✓
                    </span>
                    <span>
                      <strong>{item.label}</strong> → {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </MessageRow>
    );
  }

  const isOutgoing = message.type === "outgoing";
  const alignment = isOutgoing ? "end" : "start";

  return (
    <MessageRow align={alignment}>
      <MessageContent>
        <Bubble variant={isOutgoing ? "default" : "muted"} align={alignment}>
          <BubbleContent>{message.text}</BubbleContent>
          {message.reaction ? (
            <BubbleReactions side="bottom" align="end">
              {message.reaction}
            </BubbleReactions>
          ) : null}
        </Bubble>
      </MessageContent>
    </MessageRow>
  );
}

interface ChatPanelProps {
  chat: Chat;
  draft: string;
  composerInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ChatPanel({
  chat,
  draft,
  composerInputRef,
  onDraftChange,
  onSubmit,
}: ChatPanelProps) {
  return (
    <main className="main">
      <header className="chat-header">
        <ChatAvatar chat={chat} size="sm" />
        <h1>{chat.name}</h1>
      </header>

      <MessageScrollerProvider
        key={chat.id}
        autoScroll
        defaultScrollPosition="end"
      >
        <MessageScroller className="messages">
          <MessageScrollerViewport
            aria-label={`${chat.name} conversation`}
            aria-live="polite"
          >
            <MessageScrollerContent className="message-list">
              {chat.messages.map((message, index) => (
                <MessageScrollerItem
                  messageId={`${chat.id}-${index}`}
                  scrollAnchor={message.type === "outgoing"}
                  key={`${chat.id}-${message.type}-${index}`}
                >
                  <MessageView message={message} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form className="composer" onSubmit={onSubmit}>
        <InputGroup className="composer-input">
          <InputGroupInput
            ref={composerInputRef}
            type="text"
            aria-label={`Message ${chat.name}`}
            placeholder={`Message ${chat.name}`}
            autoComplete="off"
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
          />
          <InputGroupAddon align="inline-start">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label="Add attachment"
                    onClick={() => composerInputRef.current?.focus()}
                  />
                }
              >
                <PaperclipIcon />
              </TooltipTrigger>
              <TooltipContent>Add attachment</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    variant="default"
                    size="icon-sm"
                    type="submit"
                    aria-label="Send message"
                    disabled={!draft.trim()}
                  />
                }
              >
                <SendIcon />
              </TooltipTrigger>
              <TooltipContent>Send message</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
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
  const replyTimersRef = useRef<Set<number>>(new Set());
  const activeChat = chats[activeChatId];

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
    <TooltipProvider delay={300}>
      <div className="window">
        <header className="titlebar">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  aria-label="New chat"
                  onClick={() => composerInputRef.current?.focus()}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>

          <div className="spacer" />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  aria-label="Open in window"
                />
              }
            >
              <MonitorUpIcon />
            </TooltipTrigger>
            <TooltipContent>Open in window</TooltipContent>
          </Tooltip>
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
            onDraftChange={setDraft}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
