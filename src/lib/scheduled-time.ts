/** A suggested send time in the schedule menu. */
export interface SchedulePreset {
  label: string;
  at: Date;
}

const MORNING_HOUR = 9;

/** The person's time zone, which wall-clock schedules follow. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Suggested send times: in an hour, tomorrow morning, and next Monday morning
 * (left out when tomorrow already is Monday).
 */
export function schedulePresets(now: Date): SchedulePreset[] {
  const inAnHour = new Date(now.getTime() + 60 * 60_000);
  inAnHour.setSeconds(0, 0);
  const tomorrow = morningOf(now, 1);
  const presets: SchedulePreset[] = [
    { label: "In 1 hour", at: inAnHour },
    { label: "Tomorrow morning", at: tomorrow },
  ];
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  if (daysToMonday > 1) presets.push({ label: "Monday morning", at: morningOf(now, daysToMonday) });
  return presets;
}

function morningOf(now: Date, daysAhead: number): Date {
  const day = new Date(now);
  day.setDate(day.getDate() + daysAhead);
  day.setHours(MORNING_HOUR, 0, 0, 0);
  return day;
}

/** "Today, 3:30 PM", "Tomorrow, 9:00 AM", or "Mon, Oct 12, 9:00 AM", in local time. */
export function formatScheduledTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  const date = at.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The value a `datetime-local` input shows for a time, in local time. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The time a `datetime-local` input holds, read as local time; null when empty or invalid. */
export function fromDateTimeLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  return Number.isNaN(date.getTime()) ? null : date;
}
