import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  BellIcon,
  BellOffIcon,
  MailCheckIcon,
  MailIcon,
  PanelLeftCloseIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";

import type { ChatId, ChatListAction, ChatView, ChatViewCollection, NewWisp } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { MobileNavigation } from "@/components/mobile-navigation";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ModelSelection } from "../../shared/contracts";
import type { ToolApprovalRequest } from "../../shared/tool-policy";
import { messagePreview } from "../../shared/workspace";
import type { CurrentUser } from "@/config/app-metadata";
import { useClock } from "@/hooks/use-clock";
import { useTimeZone } from "@/hooks/use-time-zone";
import { chatName } from "@/lib/chat-schema";
import { chatActivityDate, chatActivityLabel } from "@/lib/date-dividers";
import { sidebarLayoutStyle } from "@/lib/layout";
import { panelResizer, profileAvatar } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeChatId: ChatId;
  chats: ChatViewCollection;
  collapsed: boolean;
  currentUser: CurrentUser;
  width: number;
  mobile?: boolean;
  hidden?: boolean;
  statuses?: Record<string, ManagedConversationStatus>;
  approvals?: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  /** Conversations whose last reply failed while they were not open. */
  failedChats?: Record<string, boolean>;
  loading?: boolean;
  error?: string | null;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreate: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<boolean> | void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  /** Opens the mobile Approvals tab. */
  onOpenApprovals?: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectChat: (chatId: ChatId) => void;
  /** Without it the list has no menu, as in component tests that do not need it. */
  onChatAction?: (chatId: ChatId, action: ChatListAction) => void;
}

// Product notification color intentionally remains explicit rather than a neutral surface token.
const unreadIndicator =
  "unread-dot absolute -top-1 -right-1 size-[10px] rounded-full border-2 border-sidebar bg-[#ff3b30]";
// Waiting for approval and a failed reply share a dot in the bottom corner; only the color differs.
const stateIndicator = "absolute -right-1 -bottom-1 size-[10px] rounded-full border-2 border-sidebar";
const approvalIndicator = cn("approval-indicator", stateIndicator, "bg-[#f0a83a]");
const errorIndicator = cn("error-indicator", stateIndicator, "bg-[#e5594d]");

function activityTime(chat: Parameters<typeof chatActivityDate>[0] | undefined): number {
  return (chat && chatActivityDate(chat)?.getTime()) || 0;
}

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
  failedChats = {},
  loading = false,
  error,
  onCollapsedChange,
  onCreate,
  onOpenSearch,
  onOpenSettings,
  onOpenApprovals,
  onResizeStart,
  onSelectChat,
  onChatAction,
}: SidebarProps) {
  const collapsed = !mobile && collapsedPreference;
  const [filter, setFilter] = useState<"all" | "unread" | "active">("all");
  const [menuChatId, setMenuChatId] = useState<ChatId | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const now = useClock(30_000);
  const timeZone = useTimeZone();
  const allChatIds = Object.keys(chats);
  const unreadCount = allChatIds.filter((id) => chats[id]?.unread).length;
  const chatIds = allChatIds.filter(
    (id) => !mobile || filter === "all" || (filter === "unread" ? chats[id]?.unread : statuses[id] === "working"),
  );
  // Like a messaging app, the phone list puts the latest activity first; the desktop keeps the creation order.
  if (mobile) chatIds.sort((left, right) => activityTime(chats[right]) - activityTime(chats[left]));
  // Pinned conversations come first, each group keeping that order.
  chatIds.sort((left, right) => Number(Boolean(chats[right]?.pinned)) - Number(Boolean(chats[left]?.pinned)));

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
            collapsed ? "px-2" : "px-2.5",
          )}
          aria-label="Wisps and circles"
        >
          {chatIds.map((chatId) => {
            const chat = chats[chatId];
            if (!chat) return null;
            const selected = chatId === activeChatId;
            const pendingApproval = Boolean(approvals[chatId]?.length);
            const failed = !pendingApproval && Boolean(failedChats[chatId]);
            const working = statuses[chatId] === "working";
            const activityDate = chatActivityDate(chat);
            const attention = pendingApproval ? "waiting for your approval" : failed ? "the last reply failed" : null;

            const row = (
              <button
                className={cn(
                  "conversation-list-item group/item relative mb-1 flex w-full min-w-0 items-center gap-[9px] rounded-[10px] border-0 bg-transparent p-2 text-left hover:bg-muted data-[selected=true]:bg-accent",
                  collapsed && "h-[46px] justify-center py-[5px] px-0",
                )}
                data-selected={selected}
                data-unread={chat.unread ? true : undefined}
                type="button"
                aria-current={selected ? "page" : undefined}
                aria-label={collapsed ? (attention ? `${chatName(chat)}, ${attention}` : chatName(chat)) : undefined}
                title={collapsed ? (attention ? `${chatName(chat)} — ${attention}` : chatName(chat)) : undefined}
                key={chatId}
                onClick={() => {
                  // The click that ends a long press opened the menu, not the conversation.
                  if (menuChatId !== chatId) onSelectChat(chatId);
                }}
              >
                <span className="conversation-avatar relative inline-flex flex-none">
                  <ChatAvatar
                    chat={chat}
                    state={pendingApproval ? "approval" : failed ? "error" : working ? "working" : "idle"}
                  />
                  {chat.unread && !mobile ? <span className={unreadIndicator} aria-label="Unread activity" /> : null}
                  {pendingApproval ? <span className={approvalIndicator} aria-hidden="true" /> : null}
                  {failed ? <span className={errorIndicator} aria-hidden="true" /> : null}
                </span>
                {collapsed ? null : (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <strong className="min-w-0 flex-1 overflow-hidden text-base leading-[17px] font-semibold text-ellipsis whitespace-nowrap">
                        {chatName(chat)}
                      </strong>
                      {chat.pinned ? (
                        <span className="conversation-pin flex-none self-center text-faint">
                          <PinIcon aria-hidden="true" className="size-3" />
                          <span className="sr-only">Pinned</span>
                        </span>
                      ) : null}
                      {activityDate ? (
                        <time
                          className="flex-none text-faint text-2xs leading-[17px]"
                          dateTime={activityDate.toISOString()}
                        >
                          {chatActivityLabel(activityDate, now, timeZone)}
                        </time>
                      ) : null}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          "conversation-preview mt-px min-w-0 flex-1 overflow-hidden text-faint text-sm leading-[17px] text-ellipsis whitespace-nowrap",
                          pendingApproval && "font-medium text-warning",
                          failed && "text-destructive",
                        )}
                        data-activity={
                          pendingApproval ? "approval" : failed ? "failed" : mobile && working ? "working" : undefined
                        }
                      >
                        {pendingApproval
                          ? "Waiting for your approval"
                          : failed
                            ? "The last reply failed"
                            : mobile && working
                              ? "Working…"
                              : messagePreview(chat.preview)}
                      </span>
                      {chat.unread && mobile ? (
                        <span className="conversation-unread-badge">
                          <span className="sr-only">Unread</span>
                        </span>
                      ) : null}
                    </span>
                  </span>
                )}
              </button>
            );
            if (!onChatAction) return row;
            return (
              <ContextMenu
                key={chatId}
                open={menuChatId === chatId}
                onOpenChange={(open) =>
                  setMenuChatId((current) => (open ? chatId : current === chatId ? null : current))
                }
              >
                <ContextMenuTrigger render={row} />
                <ConversationMenu chat={chat} onAction={(action) => onChatAction(chatId, action)} />
              </ContextMenu>
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
          <MobileNavigation
            current="wisps"
            onConversations={() => setFilter("all")}
            onApprovals={onOpenApprovals}
            onSettings={onOpenSettings}
            unreadCount={unreadCount}
            approvalCount={allChatIds.reduce((count, id) => count + (approvals[id]?.length ?? 0), 0)}
          />
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
            <span className={profileAvatar}>
              {currentUser.initials || <UserIcon aria-hidden="true" className="size-3.5" />}
            </span>
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

function ConversationMenu({ chat, onAction }: { chat: ChatView; onAction: (action: ChatListAction) => void }) {
  return (
    <ContextMenuContent aria-label={`Actions for ${chatName(chat)}`}>
      <ContextMenuItem onClick={() => onAction(chat.pinned ? "unpin" : "pin")}>
        {chat.pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
        {chat.pinned ? "Unpin" : "Pin"}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction(chat.notifyOnUpdatesEnabled ? "mute" : "unmute")}>
        {chat.notifyOnUpdatesEnabled ? <BellOffIcon aria-hidden="true" /> : <BellIcon aria-hidden="true" />}
        {chat.notifyOnUpdatesEnabled ? "Mute notifications" : "Turn on notifications"}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction(chat.unread ? "read" : "unread")}>
        {chat.unread ? <MailCheckIcon aria-hidden="true" /> : <MailIcon aria-hidden="true" />}
        {chat.unread ? "Mark as read" : "Mark as unread"}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export { Sidebar };
export type { SidebarProps };
