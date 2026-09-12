import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PanelLeftCloseIcon, PlusIcon, SearchIcon } from "lucide-react";

import type { ChatCollection, ChatId } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateAgentDialog, type NewAgent } from "@/components/create-agent-dialog";
import { MobileNavigation } from "@/components/mobile-navigation";
import { Button } from "@/components/ui/button";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";
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
  mobile?: boolean;
  hidden?: boolean;
  statuses?: Record<string, ManagedConversationStatus>;
  approvals?: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  loading?: boolean;
  error?: string | null;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreate: (agent: NewAgent) => Promise<boolean> | void;
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
  collapsed: collapsedPreference,
  currentUser,
  width,
  mobile = false,
  hidden = false,
  statuses = {},
  approvals = {},
  loading = false,
  error,
  onCollapsedChange,
  onCreate,
  onOpenSearch,
  onOpenSettings,
  onResizeStart,
  onSelectChat,
}: SidebarProps) {
  const collapsed = !mobile && collapsedPreference;
  const [filter, setFilter] = useState<"all" | "unread" | "active">("all");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const allChatIds = Object.keys(chats);
  const unreadCount = allChatIds.filter((id) => chats[id]?.unread).length;
  const chatIds = allChatIds.filter(
    (id) => !mobile || filter === "all" || (filter === "unread" ? chats[id]?.unread : statuses[id] === "working"),
  );

  useEffect(() => {
    if (mobile && !hidden) titleRef.current?.focus();
  }, [mobile, hidden]);

  return (
    <>
      <aside
        hidden={hidden}
        className={cn(
          "workspace-sidebar group/sidebar relative z-[2] flex min-h-0 min-w-(--sidebar-min-width) w-(--sidebar-width) flex-none flex-col overflow-hidden bg-sidebar transition-[width] duration-[180ms]",
          hidden && "hidden",
        )}
        data-collapsed={collapsed}
        style={sidebarLayoutStyle(width, collapsed)}
        aria-label="Conversations"
      >
        {mobile ? (
          <>
            <header className="mobile-list-header">
              <div>
                <h1 ref={titleRef} tabIndex={-1}>
                  Conversations
                </h1>
                <p>
                  Your team · {allChatIds.length} {allChatIds.length === 1 ? "Wisp" : "Wisps"}
                </p>
              </div>
            </header>
            <button
              className={cn(
                "sidebar-search flex h-8 flex-none items-center gap-2 rounded-lg border text-left text-dim hover:text-foreground",
                "border-border bg-card hover:border-ring",
                "[&_svg]:size-[13px] [&_svg]:flex-none [&_span]:flex-1",
              )}
              type="button"
              onClick={onOpenSearch}
            >
              <SearchIcon aria-hidden="true" />
              <span>Search conversations</span>
            </button>
          </>
        ) : (
          <div className={cn("flex h-11 flex-none items-center gap-1 px-2 pb-1", collapsed && "justify-center")}>
            {collapsed ? null : (
              <button
                className={cn(
                  "sidebar-search flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border text-left text-dim hover:text-foreground",
                  "border-border bg-card hover:border-ring",
                  "px-[9px] [&_svg]:size-[13px] [&_svg]:flex-none [&_span]:flex-1",
                )}
                type="button"
                onClick={onOpenSearch}
              >
                <SearchIcon aria-hidden="true" />
                <span>Search</span>
              </button>
            )}
            <button
              className="flex size-7 flex-none items-center justify-center border-0 bg-transparent text-dim transition-colors duration-[120ms] hover:text-foreground [&_svg]:size-[15px] [&_svg]:transition-transform [&_svg]:duration-[180ms] data-[collapsed=true]:[&_svg]:rotate-180"
              type="button"
              data-collapsed={collapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => onCollapsedChange(!collapsed)}
            >
              <PanelLeftCloseIcon aria-hidden="true" />
            </button>
          </div>
        )}

        {mobile ? (
          <div className="mobile-list-filters" role="group" aria-label="Filter conversations">
            {(
              [
                ["all", `All ${allChatIds.length}`],
                ["unread", `Unread ${unreadCount}`],
                ["active", "Active"],
              ] as const
            ).map(([id, label]) => (
              <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <nav
          className={cn(
            "conversation-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:w-0",
            collapsed ? "px-2" : "pl-[17px] pr-[10px]",
          )}
          aria-label="Wisps and circles"
        >
          {chatIds.map((chatId) => {
            const chat = chats[chatId];
            if (!chat) return null;
            const selected = chatId === activeChatId;
            const pendingApproval = Boolean(approvals[chatId]?.length);
            const working = statuses[chatId] === "working";

            return (
              <button
                className={cn(
                  "conversation-list-item group/item relative mb-1 flex w-full min-w-0 items-center gap-[9px] rounded-[10px] border-0 bg-transparent p-2 text-left hover:bg-muted data-[selected=true]:bg-accent",
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
                <span className="conversation-avatar relative inline-flex flex-none">
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
                    <span
                      className="conversation-preview mt-px overflow-hidden text-faint text-[12.5px] leading-[17px] text-ellipsis whitespace-nowrap"
                      data-activity={
                        mobile ? (pendingApproval ? "approval" : working ? "working" : undefined) : undefined
                      }
                    >
                      {mobile && pendingApproval
                        ? "Waiting for your approval"
                        : mobile && working
                          ? "Working…"
                          : chat.preview}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
          {mobile && !chatIds.length ? (
            <p className="mobile-list-empty" role={error ? "alert" : "status"}>
              {loading
                ? "Loading conversations…"
                : (error ??
                  (allChatIds.length
                    ? filter === "unread"
                      ? "You're all caught up."
                      : "No Wisps are working right now."
                    : "Create a Wisp to get started."))}
            </p>
          ) : null}
        </nav>

        <div
          className={cn(
            "sidebar-create mt-4 mb-1 mx-2.5 flex flex-none items-center justify-stretch gap-2 pt-2 [&>button]:h-[46px] [&>button]:flex-none [&>button]:rounded-[10px] [&>button]:[&_svg]:size-[13px]!",
            collapsed && "flex-col",
          )}
        >
          <CreateAgentDialog
            onCreate={onCreate}
            trigger={
              mobile ? (
                <Button className="mobile-create-button" type="button" aria-label="Create Wisp">
                  <PlusIcon aria-hidden="true" />
                </Button>
              ) : undefined
            }
          />
        </div>

        {mobile ? (
          <MobileNavigation current="wisps" onConversations={() => setFilter("all")} onSettings={onOpenSettings} />
        ) : (
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
        )}

        {collapsed || mobile ? null : (
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
