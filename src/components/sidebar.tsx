import type { ReactNode } from "react";
import { SearchIcon } from "lucide-react";

import { ChatAvatar } from "@/components/chat-avatar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
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
import { Separator } from "@/components/ui/separator";
import type { ChatCollection, ChatId } from "@/chat-data";

interface SidebarProps {
  activeChatId: ChatId;
  chatIds: ReadonlyArray<ChatId>;
  chats: ChatCollection;
  createAgentAction: ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectChat: (chatId: ChatId) => void;
}

function Sidebar({
  activeChatId,
  chatIds,
  chats,
  createAgentAction,
  query,
  onQueryChange,
  onSelectChat,
}: SidebarProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleChatIds = chatIds.filter((chatId) =>
    chats[chatId]?.name.toLocaleLowerCase().includes(normalizedQuery),
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

              if (!chat) {
                return null;
              }

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
        <div className="create-agent-action">{createAgentAction}</div>
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

export { Sidebar };
export type { SidebarProps };
