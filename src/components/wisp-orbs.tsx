import type { ChatId, ChatViewCollection, WispChatView } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import type { WispState } from "@/components/wisp";
import type { ChatListOrder } from "@/lib/app-preferences";
import { compareChats } from "@/lib/chat-order";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

interface WispOrbsProps {
  chats: ChatViewCollection;
  statuses: Record<string, ManagedConversationStatus>;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  failedChats: Record<string, boolean>;
  /** In creation order the row stays fixed instead of bringing busy Wisps forward. */
  order?: ChatListOrder;
  onSelectChat: (chatId: ChatId) => void;
}

/** Which Wisps come first: the ones waiting for the person, then working, failed, unread, and the rest. */
const ORDER: Readonly<Record<WispState | "unread", number>> = {
  approval: 0,
  working: 1,
  error: 2,
  unread: 3,
  idle: 4,
};

const DESCRIPTIONS: Readonly<Record<WispState, string>> = {
  approval: "waiting for your approval",
  working: "working",
  error: "the last reply failed",
  idle: "",
};

/** A row of every Wisp at the top of the mobile list, each showing what it is doing. */
export function WispOrbs({ chats, statuses, approvals, failedChats, order = "recent", onSelectChat }: WispOrbsProps) {
  const orbs = Object.values(chats)
    .filter((chat): chat is WispChatView => chat.kind === "wisp")
    .map((chat) => {
      const state: WispState = approvals[chat.id]?.length
        ? "approval"
        : statuses[chat.id] === "working"
          ? "working"
          : failedChats[chat.id]
            ? "error"
            : "idle";
      const rank = state === "idle" && chat.unread ? ORDER.unread : ORDER[state];
      return { chat, state, rank: order === "created" ? 0 : rank };
    })
    .sort((left, right) => left.rank - right.rank || compareChats(order, left.chat, right.chat));
  if (!orbs.length) return null;

  return (
    <nav className="wisp-orbs" aria-label="Your Wisps">
      {orbs.map(({ chat, state }) => {
        const color = wispColor(chat.wisp.name, chat.wisp.color);
        const description = [DESCRIPTIONS[state], chat.unread ? "unread" : ""].filter(Boolean).join(", ");
        return (
          <button
            key={chat.id}
            type="button"
            className="wisp-orb"
            style={wispAccentStyle(color)}
            aria-label={description ? `${chat.wisp.name}, ${description}` : chat.wisp.name}
            onClick={() => onSelectChat(chat.id)}
          >
            <span className="wisp-halo" data-state={state}>
              <WispAvatar wisp={chat.wisp} size="lg" state={state} />
              {state === "approval" || state === "error" ? (
                <span className="wisp-orb-badge" data-tone={state} aria-hidden="true">
                  !
                </span>
              ) : chat.unread ? (
                <span className="wisp-orb-badge" data-tone="unread" aria-hidden="true" />
              ) : null}
            </span>
            <span className="wisp-orb-name" aria-hidden="true">
              {chat.wisp.name}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
