import type { ReactNode } from "react";
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
} from "lucide-react";

import { ChatAvatar } from "@/components/chat-avatar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChatCollection, ChatId } from "@/chat-data";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeChatId: ChatId;
  chatIds: ReadonlyArray<ChatId>;
  chats: ChatCollection;
  collapsed: boolean;
  createAgentAction: ReactNode;
  settingsAction: ReactNode;
  query: string;
  onCollapsedChange: (collapsed: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelectChat: (chatId: ChatId) => void;
}

function Sidebar({
  activeChatId,
  chatIds,
  chats,
  collapsed,
  createAgentAction,
  settingsAction,
  query,
  onCollapsedChange,
  onQueryChange,
  onSelectChat,
}: SidebarProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleChatIds = chatIds.filter((chatId) =>
    chats[chatId]?.name.toLocaleLowerCase().includes(normalizedQuery),
  );

  return (
    <aside className="sidebar" data-collapsed={collapsed}>
      <div className="sidebar-header">
        {collapsed ? null : (
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
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                onClick={() => {
                  onCollapsedChange(!collapsed);

                  if (!collapsed) {
                    onQueryChange("");
                  }
                }}
              />
            }
          >
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </TooltipTrigger>
          <TooltipContent>
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>

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
                  className={cn(
                    "chat-item",
                    collapsed && "chat-item-collapsed h-11 w-full shrink-0",
                  )}
                  variant={isActive ? "muted" : "default"}
                  size="sm"
                  aria-current={isActive ? "page" : undefined}
                  aria-label={collapsed ? chat.name : undefined}
                  title={collapsed ? chat.name : undefined}
                  key={chatId}
                  onClick={() => onSelectChat(chatId)}
                >
                  <ItemMedia>
                    <ChatAvatar chat={chat} size="lg" />
                  </ItemMedia>
                  {collapsed ? null : (
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
                  )}
                </Item>
              );
            })}
          </ItemGroup>
        ) : collapsed ? null : (
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
        <Avatar
          size="sm"
          aria-hidden={collapsed ? undefined : true}
          aria-label={collapsed ? "Armand Segall" : undefined}
        >
          <AvatarFallback>AS</AvatarFallback>
        </Avatar>
        {collapsed ? null : (
          <>
            <span>Armand Segall</span>
            {settingsAction}
          </>
        )}
      </div>
    </aside>
  );
}

export { Sidebar };
export type { SidebarProps };
