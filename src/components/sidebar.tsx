import type { PointerEvent as ReactPointerEvent } from "react";
import { PanelLeftCloseIcon, SearchIcon } from "lucide-react";

import type { ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateAgentDialog, type NewAgent } from "@/components/create-agent-dialog";

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
    <aside className="sidebar" data-collapsed={collapsed} style={{ width: collapsed ? 68 : width }}>
      <button className="sidebar-search" type="button" aria-label={collapsed ? "Search" : undefined} onClick={onOpenSearch}>
        <SearchIcon aria-hidden="true" />
        {collapsed ? null : <span>Search</span>}
        {collapsed ? null : <kbd>⌘ K</kbd>}
      </button>

      <nav className="chat-list" aria-label="Wisps and circles">
        {chatIds.map((chatId) => {
          const chat = chats[chatId];
          if (!chat) return null;
          const selected = chatId === activeChatId;

          return (
            <button
              className="chat-item"
              data-selected={selected}
              type="button"
              aria-current={selected ? "page" : undefined}
              aria-label={collapsed ? chat.name : undefined}
              title={collapsed ? chat.name : undefined}
              key={chatId}
              onClick={() => onSelectChat(chatId)}
            >
              <span className="chat-avatar-wrap">
                <ChatAvatar chat={chat} chats={chats} />
                {chat.isActive ? <span className="presence-dot" aria-label="Active" /> : null}
              </span>
              {collapsed ? null : (
                <span className="chat-item-copy">
                  <span className="chat-item-title"><strong>{chat.name}</strong><time>{chat.timestamp}</time></span>
                  <span className="chat-item-preview">{chat.preview}</span>
                </span>
              )}
              {chat.unread ? <span className="unread-dot" aria-label="Unread activity" /> : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-bottom-actions">
        <button className="icon-pill" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => onCollapsedChange(!collapsed)}>
          <PanelLeftCloseIcon aria-hidden="true" />
        </button>
        <CreateAgentDialog chats={chats} onCreate={onCreate} />
      </div>

      <button className="profile" type="button" aria-label="Open user settings" title="User settings" onClick={onOpenSettings}>
        <span className="profile-avatar">JD</span>
        {collapsed ? null : <span>John Doe</span>}
      </button>

      {collapsed ? null : <div className="sidebar-resizer" role="separator" aria-orientation="vertical" onPointerDown={onResizeStart} />}
    </aside>
  );
}

export { Sidebar };
export type { SidebarProps };
