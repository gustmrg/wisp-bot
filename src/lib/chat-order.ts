import type { ChatSummary } from "../../shared/conversations";
import type { ChatListOrder } from "@/lib/app-preferences";
import { chatActivityDate } from "@/lib/date-dividers";

type OrderedChat = Pick<ChatSummary, "id" | "lastActivityAt" | "createdAt">;

function activityTime(chat: OrderedChat): number {
  return chatActivityDate(chat)?.getTime() || 0;
}

/** A server that predates creation times sends none: those go last, in ID order. */
function creationTime(chat: OrderedChat): number {
  const time = chat.createdAt ? Date.parse(chat.createdAt) : Number.NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * Compares two conversations for a list: latest activity first, like a
 * messaging app, or the order they were created in, oldest first, which a
 * new message never changes. Ties keep a fixed order by ID.
 */
export function compareChats(order: ChatListOrder, left: OrderedChat, right: OrderedChat): number {
  const byOrder =
    order === "created" ? creationTime(left) - creationTime(right) : activityTime(right) - activityTime(left);
  return (Number.isNaN(byOrder) ? 0 : byOrder) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** The conversations in list order: pinned ones first, each group in the chosen order. */
export function sortChats<T extends OrderedChat & Pick<ChatSummary, "pinned">>(
  chats: ReadonlyArray<T>,
  order: ChatListOrder,
): T[] {
  return [...chats].sort(
    (left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || compareChats(order, left, right),
  );
}
