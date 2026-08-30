import type { PointerEvent as ReactPointerEvent } from "react";
import { PanelLeftCloseIcon, SearchIcon } from "lucide-react";

import type { ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateAgentDialog, type NewAgent } from "@/components/create-agent-dialog";
import { panelResizer, profileAvatar } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeChatId: ChatId;
  chats: ChatCollection;
  collapsed: boolean;
  width: number;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreate: (agent: NewAgent) => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectChat: (chatId: ChatId) => void;
}

function Sidebar({
  activeChatId,
  chats,
  collapsed,
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
        className="group/sidebar relative z-[2] flex min-h-0 min-w-[68px] flex-none flex-col overflow-hidden border-r border-black/[0.055] bg-sidebar transition-[width] duration-[180ms] dark:border-white/[0.055] max-[620px]:data-[collapsed=false]:w-[220px]!"
        data-collapsed={collapsed}
        style={{ width: collapsed ? 68 : width }}
      >
      <button
        className={cn(
          "flex h-[29px] flex-none items-center gap-[7px] rounded-lg border-0 px-[9px] text-left text-[#686868] hover:bg-[#f4f4f4] hover:text-[#5c5c5c] dark:bg-[#1a1a1a] dark:text-[#828282] dark:hover:bg-[#202020] dark:hover:text-[#b8b8b8]",
          "[&_svg]:size-[13px] [&_svg]:flex-none [&_span]:flex-1 [&_kbd]:text-[10px] [&_kbd]:text-[#737373] [&_kbd]:[font-family:inherit] dark:[&_kbd]:text-[#666666]",
          "mt-3 mx-2.5 mb-2",
          collapsed && "mx-auto w-9 justify-center p-0",
        )}
        type="button"
        aria-label={collapsed ? "Search" : undefined}
        onClick={onOpenSearch}
      >
        <SearchIcon aria-hidden="true" />
        {collapsed ? null : <span>Search</span>}
        {collapsed ? null : <kbd>⌘ K</kbd>}
      </button>

      <nav className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 [&::-webkit-scrollbar]:w-0" aria-label="Wisps and circles">
        {chatIds.map((chatId) => {
          const chat = chats[chatId];
          if (!chat) return null;
          const selected = chatId === activeChatId;

          return (
            <button
              className={cn(
                "group/item relative mb-px flex w-full min-w-0 items-center gap-[9px] rounded-[10px] border-0 bg-transparent p-2 text-left hover:bg-[#ebebeb] data-[selected=true]:bg-[#e6e6e6] dark:hover:bg-[#171717] dark:data-[selected=true]:bg-[#303030]",
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
                {chat.isActive ? <span className="absolute -bottom-0.5 -left-0.5 size-2.5 rounded-full border-[2.5px] border-sidebar bg-green" aria-label="Active" /> : null}
              </span>
              {collapsed ? null : (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <strong className="min-w-0 flex-1 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap">{chat.name}</strong>
                    <time className="flex-none text-faint text-[10.5px] group-has-[.unread-dot]/item:invisible">{chat.timestamp}</time>
                  </span>
                  <span className="mt-px overflow-hidden text-dim text-[12.5px] text-ellipsis whitespace-nowrap">{chat.preview}</span>
                </span>
              )}
              {chat.unread ? (
                <span
                  className={cn(
                    "absolute size-[7px] rounded-full bg-blue",
                    collapsed ? "top-[7px] right-[5px]" : "right-[9px]",
                  )}
                  aria-label="Unread activity"
                />
              ) : null}
            </button>
          );
        })}
      </nav>

      <div
        className={cn(
          "mt-4 mb-1 flex flex-none items-center justify-between gap-2 pt-2 mx-2.5 [&>button]:h-[29px] [&>button]:w-9 [&>button]:flex-none [&>button]:rounded-lg [&>button]:[&_svg]:size-[13px]!",
          collapsed && "flex-col",
        )}
      >
        <CreateAgentDialog chats={chats} onCreate={onCreate} />
      </div>

      <button
        className={cn(
          "flex min-w-0 flex-none items-center gap-[9px] rounded-[9px] border-0 bg-transparent p-1.5 text-left hover:bg-[#ebebeb] dark:hover:bg-[#171717]",
          "mt-[5px] mx-[9px] mb-[9px]",
          collapsed && "mx-2 justify-center px-0",
        )}
        type="button"
        aria-label="Open user settings"
        title="User settings"
        onClick={onOpenSettings}
      >
        <span className={profileAvatar}>JD</span>
        {collapsed ? null : <span className="min-w-0 flex-1 truncate">John Doe</span>}
      </button>

      {collapsed ? null : <div className={cn(panelResizer, "-right-1")} role="separator" aria-orientation="vertical" onPointerDown={onResizeStart} />}
      </aside>
      <button
        className="z-[3] flex size-[22px] flex-none self-start items-center justify-center rounded-md border border-black/[0.12] bg-[#f7f7f7] text-[#686868] transition-[background-color,color] duration-[120ms] hover:bg-[#eaeaea] hover:text-[#444444] dark:border-white/[0.12] dark:bg-[#262626] dark:text-[#9a9a9a] dark:hover:bg-[#313131] dark:hover:text-[#dddddd] -mx-[11px] mt-[15px] [&_svg]:size-[13px] [&_svg]:transition-transform [&_svg]:duration-[180ms] data-[collapsed=true]:[&_svg]:rotate-180"
        type="button"
        data-collapsed={collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={() => onCollapsedChange(!collapsed)}
      >
        <PanelLeftCloseIcon aria-hidden="true" />
      </button>
    </>
  );
}

export { Sidebar };
export type { SidebarProps };
