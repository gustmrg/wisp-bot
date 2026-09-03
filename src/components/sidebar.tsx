import type { PointerEvent as ReactPointerEvent } from "react";
import { PanelLeftCloseIcon, SearchIcon } from "lucide-react";

import type { ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateAgentDialog, type NewAgent } from "@/components/create-agent-dialog";
import type { CurrentUser } from "@/config/app-metadata";
import { sidebarLayoutStyle } from "@/lib/layout";
import { panelResizer, profileAvatar } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeChatId: ChatId;
  chats: ChatCollection;
  collapsed: boolean;
  currentUser: CurrentUser;
  width: number;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreate: (agent: NewAgent) => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectChat: (chatId: ChatId) => void;
}

// Product notification color intentionally remains explicit rather than a neutral surface token.
const unreadIndicator =
  "unread-dot absolute -top-1 -right-1 size-[10px] rounded-full border-2 border-sidebar bg-[#ff3b30]";

function Sidebar({
  activeChatId,
  chats,
  collapsed,
  currentUser,
  width,
  onCollapsedChange,
  onCreate,
  onOpenSearch,
  onOpenSettings,
  onResizeStart,
  onSelectChat,
}: SidebarProps) {
  const chatIds = Object.keys(chats);

  return (
    <>
      <aside
        className="group/sidebar relative z-[2] flex min-h-0 min-w-(--sidebar-min-width) w-(--sidebar-width) flex-none flex-col overflow-hidden bg-sidebar transition-[width] duration-[180ms] max-[620px]:data-[collapsed=false]:w-(--sidebar-mobile-expanded-width)!"
        data-collapsed={collapsed}
        style={sidebarLayoutStyle(width, collapsed)}
      >
        <div className={cn("flex h-11 flex-none items-center px-2", collapsed ? "justify-center" : "justify-end")}>
          <button
            className="flex size-7 items-center justify-center border-0 bg-transparent text-dim transition-colors duration-[120ms] hover:text-foreground [&_svg]:size-[15px] [&_svg]:transition-transform [&_svg]:duration-[180ms] data-[collapsed=true]:[&_svg]:rotate-180"
            type="button"
            data-collapsed={collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            <PanelLeftCloseIcon aria-hidden="true" />
          </button>
        </div>

        <button
          className={cn(
            "flex h-8 flex-none items-center gap-2 rounded-lg border text-left text-dim hover:text-foreground",
            "border-border bg-card hover:border-ring",
            "mb-2 [&_svg]:size-[13px] [&_svg]:flex-none [&_span]:flex-1",
            collapsed ? "mx-auto w-9 justify-center p-0" : "ml-[17px] mr-[10px] px-[9px]",
          )}
          type="button"
          aria-label={collapsed ? "Search" : undefined}
          onClick={onOpenSearch}
        >
          <SearchIcon aria-hidden="true" />
          {collapsed ? null : <span>Search</span>}
        </button>

        <nav
          className={cn(
            "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:w-0",
            collapsed ? "px-2" : "pl-[17px] pr-[10px]",
          )}
          aria-label="Wisps and circles"
        >
          {chatIds.map((chatId) => {
            const chat = chats[chatId];
            if (!chat) return null;
            const selected = chatId === activeChatId;

            return (
              <button
                className={cn(
                  "group/item relative mb-1 flex w-full min-w-0 items-center gap-[9px] rounded-[10px] border-0 bg-transparent p-2 text-left hover:bg-muted data-[selected=true]:bg-accent",
                  collapsed && "h-[46px] justify-center py-[5px] px-0",
                )}
                data-selected={selected}
                type="button"
                aria-current={selected ? "page" : undefined}
                aria-label={collapsed ? chat.name : undefined}
                title={collapsed ? chat.name : undefined}
                key={chatId}
                onClick={() => onSelectChat(chatId)}
              >
                <span className="relative inline-flex flex-none">
                  <ChatAvatar chat={chat} chats={chats} />
                  {chat.unread ? <span className={unreadIndicator} aria-label="Unread activity" /> : null}
                </span>
                {collapsed ? null : (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <strong className="min-w-0 flex-1 overflow-hidden text-[13px] leading-[17px] font-semibold text-ellipsis whitespace-nowrap">
                        {chat.name}
                      </strong>
                      <time className="flex-none text-faint text-[10.5px] leading-[17px]">{chat.timestamp}</time>
                    </span>
                    <span className="mt-px overflow-hidden text-faint text-[12.5px] leading-[17px] text-ellipsis whitespace-nowrap">
                      {chat.preview}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div
          className={cn(
            "mt-4 mb-1 mx-2.5 flex flex-none items-center justify-between gap-2 pt-2 [&>button]:h-[46px] [&>button]:flex-none [&>button]:rounded-[10px] [&>button]:[&_svg]:size-[13px]!",
            collapsed && "flex-col",
          )}
        >
          <CreateAgentDialog onCreate={onCreate} />
        </div>

        <button
          className={cn(
            "flex min-w-0 flex-none items-center gap-[9px] rounded-[9px] border-0 bg-transparent p-1.5 text-left hover:bg-muted",
            "mt-[5px] mx-3 mb-[9px]",
            collapsed && "mx-2 justify-center px-0",
          )}
          type="button"
          aria-label="Open user settings"
          title="User settings"
          onClick={onOpenSettings}
        >
          <span className={profileAvatar}>{currentUser.initials}</span>
          {collapsed ? null : <span className="min-w-0 flex-1 truncate">{currentUser.displayName}</span>}
        </button>

        {collapsed ? null : (
          <div
            className={cn(panelResizer, "-right-1")}
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onResizeStart}
          />
        )}
      </aside>
    </>
  );
}

export { Sidebar };
export type { SidebarProps };
