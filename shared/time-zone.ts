const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The calendar date and wall-clock time of an instant in one time zone. */
export interface ZonedParts {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 (Sunday) to 6 (Saturday). */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const partFormatters = new Map<string, Intl.DateTimeFormat>();

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The time zone of the device running this code. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const { type, value } of partFormatter(timeZone).formatToParts(date)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ""),
  };
}

/** A number for the calendar day an instant falls on in `timeZone`; consecutive days differ by one. */
export function zonedDayNumber(date: Date, timeZone: string): number {
  const { year, month, day } = zonedParts(date, timeZone);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/**
 * The instant a wall-clock time happens in `timeZone`. Days and months past
 * their range roll over, as with `Date.UTC`. A time skipped when clocks go
 * forward resolves to the first instant after the gap (02:30 becomes 03:00);
 * a time that happens twice when clocks go back resolves to the first.
 */
export function zonedTime(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  // Offsets change at most once within a day, so the offsets a day either side are the only candidates.
  const before = offsetAt(target - DAY_MS, timeZone);
  const after = offsetAt(target + DAY_MS, timeZone);
  // A larger offset gives an earlier instant, so it is tried first.
  const larger = Math.max(before, after);
  const smaller = Math.min(before, after);
  for (const offset of [larger, smaller]) {
    if (offsetAt(target - offset, timeZone) === offset) return new Date(target - offset);
  }
  // Skipped: find the minute the clocks went forward, between the two readings.
  let low = target - larger;
  let high = target - smaller;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetAt(middle, timeZone) === before) low = middle;
    else high = middle;
  }
  return new Date(high);
}

/** How far the wall clock in `timeZone` is ahead of UTC at an instant, to the minute. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = zonedParts(new Date(instant), timeZone);
  const minute = Math.floor(instant / MINUTE_MS) * MINUTE_MS;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - minute;
}
