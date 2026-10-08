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
 * their range roll over, as with `Date.UTC`. A time skipped by a daylight
 * saving change resolves to the instant just after the gap.
 */
export function zonedTime(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  timeZone: string,
): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  let instant = target;
  // The offset at the guess can differ from the offset at the answer near a change; two passes settle it.
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    instant += target - shown;
  }
  return new Date(instant);
}
