import { systemTimeZone, zonedDayNumber, zonedParts, zonedTime } from "../../shared/time-zone";

/** A suggested send time in the schedule menu. */
export interface SchedulePreset {
  label: string;
  at: Date;
}

const MORNING_HOUR = 9;

/**
 * Suggested send times: in an hour, tomorrow morning, and next Monday morning
 * (left out when tomorrow already is Monday), with mornings in `timeZone`.
 */
export function schedulePresets(now: Date, timeZone: string = systemTimeZone()): SchedulePreset[] {
  const inAnHour = new Date(now.getTime() + 60 * 60_000);
  inAnHour.setSeconds(0, 0);
  const tomorrow = morningOf(now, 1, timeZone);
  const presets: SchedulePreset[] = [
    { label: "In 1 hour", at: inAnHour },
    { label: "Tomorrow morning", at: tomorrow },
  ];
  const daysToMonday = (8 - zonedParts(now, timeZone).weekday) % 7 || 7;
  if (daysToMonday > 1) presets.push({ label: "Monday morning", at: morningOf(now, daysToMonday, timeZone) });
  return presets;
}

function morningOf(now: Date, daysAhead: number, timeZone: string): Date {
  const today = zonedParts(now, timeZone);
  return zonedTime({ ...today, day: today.day + daysAhead, hour: MORNING_HOUR, minute: 0 }, timeZone);
}

/** "Today, 3:30 PM", "Tomorrow, 9:00 AM", or "Mon, Oct 12, 9:00 AM", in `timeZone`. */
export function formatScheduledTime(at: Date, now: Date, timeZone: string = systemTimeZone()): string {
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone });
  const days = zonedDayNumber(at, timeZone) - zonedDayNumber(now, timeZone);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  const date = at.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
    ...(zonedParts(at, timeZone).year === zonedParts(now, timeZone).year ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

/** The value a `datetime-local` input shows for a time, in `timeZone`. */
export function toDateTimeLocalValue(date: Date, timeZone: string = systemTimeZone()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const { year, month, day, hour, minute } = zonedParts(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** The time a `datetime-local` input holds, read in `timeZone`; null when empty or invalid. */
export function fromDateTimeLocalValue(value: string, timeZone: string = systemTimeZone()): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = zonedTime({ year, month, day, hour, minute }, timeZone);
  return Number.isNaN(date.getTime()) ? null : date;
}
