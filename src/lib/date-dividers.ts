import type { ChatSummary, Message } from "../../shared/conversations";
import { systemTimeZone, zonedDayNumber, zonedParts } from "../../shared/time-zone";

const MINUTE_MS = 60_000;

function shortDate(date: Date, timeZone: string, withYear = true): string {
  const { year, month, day } = zonedParts(date, timeZone);
  const dayMonth = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  return withYear ? `${dayMonth}/${year}` : dayMonth;
}

function messageDate(message: Message): Date | null {
  if (!message.createdAt) return null;
  const date = new Date(message.createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateDividerLabel(date: Date, now: Date = new Date(), timeZone: string = systemTimeZone()): string {
  const dayDiff = zonedDayNumber(date, timeZone) - zonedDayNumber(now, timeZone);
  if (dayDiff === 0) return "Today";
  if (dayDiff === -1) return "Yesterday";
  return shortDate(date, timeZone);
}

// Groups a transcript into calendar days the way mainstream chat apps do: a divider before the
// first timestamped message and before every day change, using day boundaries in `timeZone`.
export function withDateDividers(
  messages: ReadonlyArray<Message>,
  now: Date = new Date(),
  timeZone: string = systemTimeZone(),
): Array<Message> {
  const result: Array<Message> = [];
  let currentDay: number | null = null;
  for (const message of messages) {
    const date = messageDate(message);
    if (date) {
      const day = zonedDayNumber(date, timeZone);
      if (day !== currentDay) {
        currentDay = day;
        result.push({ id: `date:${day}`, type: "time", text: dateDividerLabel(date, now, timeZone) });
      }
    }
    result.push(message);
  }
  return result;
}

// The chat's last activity as the backend records it.
export function chatActivityDate(chat: Pick<ChatSummary, "lastActivityAt">): Date | null {
  if (!chat.lastActivityAt) return null;
  const date = new Date(chat.lastActivityAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Compact recency label for conversation lists, computed at render time so it never goes stale.
export function chatActivityLabel(date: Date, now: Date = new Date(), timeZone: string = systemTimeZone()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return "Now";
  if (elapsed < 60 * MINUTE_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  const dayDiff = zonedDayNumber(now, timeZone) - zonedDayNumber(date, timeZone);
  if (dayDiff === 0) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone });
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return date.toLocaleDateString([], { weekday: "short", timeZone });
  return shortDate(date, timeZone, zonedParts(date, timeZone).year !== zonedParts(now, timeZone).year);
}
