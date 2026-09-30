import type { ChatSummary, Message } from "../../shared/conversations";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function messageDate(message: Message): Date | null {
  if (!message.createdAt) return null;
  const date = new Date(message.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateDividerLabel(date: Date, now: Date = new Date()): string {
  const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (dayDiff === 0) return "Today";
  if (dayDiff === -1) return "Yesterday";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

// Groups a transcript into calendar days the way mainstream chat apps do: a divider before the
// first timestamped message and before every day change, using local-time day boundaries.
export function withDateDividers(messages: ReadonlyArray<Message>, now: Date = new Date()): Array<Message> {
  const result: Array<Message> = [];
  let currentDay: number | null = null;
  for (const message of messages) {
    const date = messageDate(message);
    if (date) {
      const day = startOfDay(date);
      if (day !== currentDay) {
        currentDay = day;
        result.push({ id: `date:${day}`, type: "time", text: dateDividerLabel(date, now) });
      }
    }
    result.push(message);
  }
  return result;
}

// The chat's last activity as the backend records it, falling back to the chat's own ISO
// timestamp. Older stores saved display strings such as "Now" there; those carry no date and
// are ignored.
export function chatActivityDate(chat: Pick<ChatSummary, "lastActivityAt" | "timestamp">): Date | null {
  const value = chat.lastActivityAt ?? (ISO_TIMESTAMP_PATTERN.test(chat.timestamp) ? chat.timestamp : undefined);
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Compact recency label for conversation lists, computed at render time so it never goes stale.
export function chatActivityLabel(date: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return "Now";
  if (elapsed < 60 * MINUTE_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (dayDiff === 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: "short" });
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return date.getFullYear() === now.getFullYear() ? `${day}/${month}` : `${day}/${month}/${date.getFullYear()}`;
}
