import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  BellIcon,
  BellOffIcon,
  MailCheckIcon,
  MailIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";

import type { ChatId, ChatListAction, ChatView, ChatViewCollection, NewCircle, NewWisp } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { CreateChatDialog } from "@/components/create-chat-dialog";
import { MobileNavigation } from "@/components/mobile-navigation";
import { NeedsYou } from "@/components/needs-you";
import { WispOrbs } from "@/components/wisp-orbs";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { WispTemplateEntry } from "../../shared/wisp-template";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ModelSelection } from "../../shared/contracts";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { messagePreview } from "../../shared/workspace";
import type { CurrentUser } from "@/config/app-metadata";
import { useClock } from "@/hooks/use-clock";
import type { ChatListOrder } from "@/lib/app-preferences";
import { sortChats } from "@/lib/chat-order";
import { useTimeFormat, useTimeZone } from "@/hooks/use-time-zone";
import { chatName } from "@/lib/chat-schema";
import { chatActivityDate, chatActivityLabel } from "@/lib/date-dividers";
import { sidebarLayoutStyle } from "@/lib/layout";
import { formatShortcut, TOGGLE_SIDEBAR_SHORTCUT } from "@/lib/shortcuts";
import { panelResizer, profileAvatar } from "@/lib/ui-classes";
import { ConnectionSwitcher } from "@/features/connections/connection-switcher";
import { cn } from "@/lib/utils";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";

interface SidebarProps {
  activeChatId: ChatId;
  chats: ChatViewCollection;
  currentUser: CurrentUser;
  width: number;
  mobile?: boolean;
  hidden?: boolean;
  /** On the desktop, folds the list to a rail of avatars. */
  collapsed?: boolean;
  /** Folds or unfolds the desktop list; without it there is no button to. */
  onToggleCollapsed?: () => void;
  /** On mobile, shows every Wisp in a row above the conversations. */
  showWispsRow?: boolean;
  /** Latest activity first, or fixed in creation order; pinned conversations come first either way. */
  order?: ChatListOrder;
  statuses?: Record<string, ManagedConversationStatus>;
  /** What each working conversation is doing, such as "Searching the web". */
  activity?: Record<string, string | undefined>;
  approvals?: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  /** Conversations whose last reply failed while they were not open. */
  failedChats?: Record<string, boolean>;
  loading?: boolean;
  error?: string | null;
  /** Resolves with the new Wisp's conversation ID, or null when it could not be created. */
  onCreate: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<string | null>;
  /** Resolves true once the circle exists; with it, the create button offers a circle as well as a Wisp. */
  onCreateCircle?: (circle: NewCircle) => Promise<boolean>;
  /** A template chosen in Settings: the create dialog opens with it until it closes. */
  createFromTemplate?: WispTemplateEntry | null;
  onCreateFromTemplateClosed?: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTemplates?: () => void;
  /** Opens the connections in Settings; without it, Settings opens where it does for the profile. */
  onManageConnections?: () => void;
  /** Opens the mobile Approvals tab. */
  onOpenApprovals?: () => void;
  /** Answers an approval from the mobile list; without it the list does not offer to. */
  onResolveApproval?: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectChat: (chatId: ChatId) => void;
  /** Without it the list has no menu, as in component tests that do not need it. */
  onChatAction?: (chatId: ChatId, action: ChatListAction) => void;
}

// Product notification color intentionally remains explicit rather than a neutral surface token.
/** The folded list: wide enough for an avatar and its row's padding. */
const RAIL_WIDTH = "w-[60px]";

const toolButton =
  "flex size-[34px] flex-none items-center justify-center rounded-[10px] border-0 bg-foreground/[0.05] text-dim transition-colors duration-[120ms] hover:bg-foreground/[0.08] hover:text-foreground [&_svg]:size-4";

const unreadIndicator =
  "unread-dot absolute -top-1 -right-1 size-[10px] rounded-full border-2 border-sidebar bg-[#ff3b30]";

/** "Good morning", "Good afternoon", or "Good evening", by the hour where the person is. */
function greeting(now: Date, timeZone: string, name: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  return name ? `Good ${part}, ${name}` : `Good ${part}`;
}

function Sidebar({
  activeChatId,
  chats,
  currentUser,
  width,
  mobile = false,
  hidden = false,
  collapsed = false,
  onToggleCollapsed,
  showWispsRow = true,
  order = "recent",
  statuses = {},
  activity = {},
  approvals = {},
  failedChats = {},
  loading = false,
  error,
  onCreate,
  onCreateCircle,
  createFromTemplate,
  onCreateFromTemplateClosed,
  onOpenSearch,
  onOpenSettings,
  onOpenTemplates,
  onManageConnections,
  onOpenApprovals,
  onResolveApproval,
  onResizeStart,
  onSelectChat,
  onChatAction,
}: SidebarProps) {
  const [filter, setFilter] = useState<"all" | "unread" | "active">("all");
  const [menuChatId, setMenuChatId] = useState<ChatId | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const rail = !mobile && collapsed;
  const toggleLabel = `${rail ? "Expand" : "Collapse"} sidebar (${formatShortcut(TOGGLE_SIDEBAR_SHORTCUT)})`;
  const toggleButton = onToggleCollapsed ? (
    <button
      className={cn(toolButton, "bg-transparent")}
      type="button"
      aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!rail}
      title={toggleLabel}
      onClick={onToggleCollapsed}
    >
      {rail ? <PanelLeftOpenIcon aria-hidden="true" /> : <PanelLeftCloseIcon aria-hidden="true" />}
    </button>
  ) : null;
  const now = useClock(30_000);
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const allChatIds = Object.keys(chats);
  const unreadCount = allChatIds.filter((id) => chats[id]?.unread).length;
  const chatIds = sortChats(
    Object.values(chats).filter(
      (chat) => !mobile || filter === "all" || (filter === "unread" ? chat.unread : statuses[chat.id] === "working"),
    ),
    order,
  ).map((chat) => chat.id);

  useEffect(() => {
    if (mobile && !hidden) titleRef.current?.focus();
  }, [mobile, hidden]);

  // The open conversation stays in view when it or the order changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: those changes are what scroll it back into view.
  useEffect(() => {
    listRef.current?.querySelector("[aria-current='page']")?.scrollIntoView?.({ block: "nearest" });
  }, [activeChatId, order]);

  return (
    <>
      <aside
        hidden={hidden}
        className={cn(
          "workspace-sidebar relative z-[2] flex min-h-0 flex-none flex-col overflow-hidden bg-sidebar",
          rail ? RAIL_WIDTH : "w-(--sidebar-width)",
          hidden && "hidden",
        )}
        data-collapsed={rail || undefined}
        style={sidebarLayoutStyle(width)}
        aria-label="Conversations"
      >
        {mobile ? (
          <>
            <header className="mobile-list-header">
              <div>
                <p className="mobile-list-greeting">{greeting(now, timeZone, currentUser.givenName)}</p>
                <h1 ref={titleRef} tabIndex={-1}>
                  Wisps
                </h1>
              </div>
            </header>
            <button
              className="mobile-list-search"
              type="button"
              aria-label="Search conversations"
              title="Search conversations"
              onClick={onOpenSearch}
            >
              <SearchIcon aria-hidden="true" />
            </button>
            {showWispsRow ? (
              <WispOrbs
                chats={chats}
                statuses={statuses}
                approvals={approvals}
                failedChats={failedChats}
                order={order}
                onSelectChat={onSelectChat}
              />
            ) : null}
            {onResolveApproval ? (
              <NeedsYou
                chats={chats}
                approvals={approvals}
                onResolve={onResolveApproval}
                onOpenChat={onSelectChat}
                onOpenApprovals={onOpenApprovals}
              />
            ) : null}
          </>
        ) : rail ? (
          // The Create Wisp button, rendered further down, takes the space left below these.
          <div className="flex flex-none flex-col items-center gap-1.5 pt-[11px] pb-[46px]">
            {toggleButton}
            <button
              className={cn(toolButton, "sidebar-search")}
              type="button"
              aria-label="Search"
              title="Search"
              onClick={onOpenSearch}
            >
              <SearchIcon aria-hidden="true" />
            </button>
          </div>
        ) : (
          // The Create Wisp button, rendered further down, is placed at the end of this row.
          <div className="flex h-[52px] flex-none items-center gap-1.5 pt-2 pr-[50px] pl-2 pb-1">
            {toggleButton}
            <button
              className={cn(
                "sidebar-search flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] border-0 text-left text-dim hover:text-foreground",
                "bg-foreground/[0.05] hover:bg-foreground/[0.08]",
                "px-2.5 [&_svg]:size-[15px] [&_svg]:flex-none [&_span]:flex-1",
              )}
              type="button"
              onClick={onOpenSearch}
            >
              <SearchIcon aria-hidden="true" />
              <span>Search</span>
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
          ref={listRef}
          className={cn(
            "conversation-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:w-0",
            rail ? "border-t border-border px-1 pt-2" : "px-2.5",
          )}
          aria-label="Wisps and circles"
        >
          {chatIds.map((chatId) => {
            const chat = chats[chatId];
            if (!chat) return null;
            // On a phone the list is its own page, so no conversation is open beside it.
            const selected = !mobile && chatId === activeChatId;
            const pendingApproval = Boolean(approvals[chatId]?.length);
            const failed = !pendingApproval && Boolean(failedChats[chatId]);
            const working = statuses[chatId] === "working";
            const activityDate = chatActivityDate(chat);
            const color = chat.kind === "wisp" ? wispColor(chat.wisp.name, chat.wisp.color) : undefined;
            const role = chat.kind === "wisp" ? chat.wisp.role.trim() : "";

            const row = (
              <button
                className={cn(
                  "conversation-list-item group/item relative mb-1 flex min-w-0 items-center gap-[9px] rounded-[10px] border-0 bg-transparent text-left hover:bg-muted data-[selected=true]:bg-accent",
                  // In the rail the item just holds the 44px avatar and its ring, centered with a margin to the rail's edges.
                  rail ? "mx-auto size-12 justify-center p-0" : "w-full p-2",
                )}
                data-selected={selected}
                data-unread={chat.unread ? true : undefined}
                style={color ? wispAccentStyle(color) : undefined}
                type="button"
                aria-current={selected ? "page" : undefined}
                aria-label={
                  rail
                    ? railLabel(chatName(chat), { pendingApproval, failed, working, unread: chat.unread })
                    : undefined
                }
                title={rail ? chatName(chat) : undefined}
                key={chatId}
                onClick={() => {
                  // The click that ends a long press opened the menu, not the conversation.
                  if (menuChatId !== chatId) onSelectChat(chatId);
                }}
              >
                <span
                  className="conversation-avatar wisp-halo relative inline-flex flex-none"
                  data-state={pendingApproval ? "approval" : failed ? "error" : working ? "working" : "idle"}
                >
                  <ChatAvatar
                    chat={chat}
                    state={pendingApproval ? "approval" : failed ? "error" : working ? "working" : "idle"}
                  />
                  {chat.unread && !mobile ? <span className={unreadIndicator} aria-label="Unread activity" /> : null}
                </span>
                {rail ? null : (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <strong className="min-w-0 overflow-hidden text-base leading-[17px] font-semibold text-ellipsis whitespace-nowrap">
                        {chatName(chat)}
                      </strong>
                      {role ? (
                        <small className="conversation-role min-w-0 flex-[0_1_auto] truncate">{role}</small>
                      ) : null}
                      <span className="flex-1" />
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
                          {chatActivityLabel(activityDate, now, timeZone, timeFormat)}
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
                          pendingApproval ? "approval" : failed ? "failed" : working ? "working" : undefined
                        }
                      >
                        {pendingApproval
                          ? "Waiting for your approval"
                          : failed
                            ? "The last reply failed"
                            : working
                              ? (activity[chatId] ?? "Working…")
                              : messagePreview(chat.preview)}
                      </span>
                      {chat.unread && mobile ? (
                        // A server that predates counts sends only `unread`: a dot then.
                        <span className="conversation-unread-badge" data-counted={chat.unreadCount ? true : undefined}>
                          {chat.unreadCount ? (
                            <>
                              <span aria-hidden="true">{chat.unreadCount > 99 ? "99+" : chat.unreadCount}</span>
                              <span className="sr-only">{`${chat.unreadCount} unread`}</span>
                            </>
                          ) : (
                            <span className="sr-only">Unread</span>
                          )}
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

        {/* One dialog for both layouts, so a Wisp being created survives a change between them. */}
        {/* In the rail it sits below the search button, in the space the rail leaves for it. */}
        <div
          className={
            mobile
              ? "sidebar-create"
              : rail
                ? "absolute top-[91px] left-[13px] z-[1]"
                : "absolute top-[11px] right-2 z-[1]"
          }
        >
          <CreateChatDialog
            onCreate={onCreate}
            onCreateCircle={onCreateCircle}
            wisps={Object.values(chats).flatMap((chat) => (chat.kind === "wisp" ? [chat.wisp] : []))}
            {...(onOpenTemplates ? { onOpenTemplates } : {})}
            trigger={createButton(mobile, onCreateCircle ? "Create" : "Create Wisp")}
            {...(createFromTemplate
              ? {
                  template: createFromTemplate,
                  open: true,
                  onOpenChange: (open: boolean) => {
                    if (!open) onCreateFromTemplateClosed?.();
                  },
                }
              : {})}
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
          <>
            <ConnectionSwitcher rail={rail} onManage={onManageConnections ?? onOpenSettings} />
            <button
              className={cn(
                "flex min-w-0 flex-none items-center gap-[9px] rounded-[9px] border-0 bg-transparent p-1.5 text-left hover:bg-muted",
                "mt-[5px] mx-3 mb-[9px]",
                rail && "mx-auto",
              )}
              type="button"
              aria-label="Open user settings"
              title="User settings"
              onClick={onOpenSettings}
            >
              <span className={profileAvatar}>
                {currentUser.initials || <UserIcon aria-hidden="true" className="size-3.5" />}
              </span>
              {rail ? null : <span className="min-w-0 flex-1 truncate">{currentUser.displayName}</span>}
            </button>
          </>
        )}

        {mobile || rail ? null : (
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

function createButton(mobile: boolean, label: string) {
  return mobile ? (
    <Button className="mobile-create-button" type="button" aria-label={label}>
      <PlusIcon aria-hidden="true" />
    </Button>
  ) : (
    <button className={toolButton} type="button" aria-label={label} title={label}>
      <PlusIcon aria-hidden="true" />
    </button>
  );
}

/** What a folded row says, since only its avatar shows. */
function railLabel(
  name: string,
  state: { pendingApproval: boolean; failed: boolean; working: boolean; unread?: boolean },
): string {
  const status = state.pendingApproval
    ? "waiting for your approval"
    : state.failed
      ? "the last reply failed"
      : state.working
        ? "working"
        : null;
  return [name, status, state.unread ? "unread" : null].filter(Boolean).join(", ");
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
