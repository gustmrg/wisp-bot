import type { Message } from "../../shared/conversations";

const DAY_MS = 86_400_000;

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
