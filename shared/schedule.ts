import { isTimeZone, zonedParts, zonedTime } from "./time-zone.js";

/** 0 (Sunday) to 6 (Saturday). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** When a recurring schedule stops: after a local date (inclusive), or after a number of runs. */
export type ScheduleEnd = { kind: "until"; date: string } | { kind: "count"; count: number };

export type OnceSchedule = { kind: "once"; at: string };
/** Every day at a local time (`HH:MM`). */
export type DailySchedule = { kind: "daily"; time: string; end?: ScheduleEnd };
/** On some weekdays at a local time. */
export type WeeklySchedule = { kind: "weekly"; weekdays: ReadonlyArray<Weekday>; time: string; end?: ScheduleEnd };
/** On a day of the month at a local time; months without that day use their last day. */
export type MonthlySchedule = { kind: "monthly"; day: number; time: string; end?: ScheduleEnd };

/**
 * When something happens: once at an instant, or on a rule evaluated in a
 * time zone kept beside the schedule. Nothing recurs more than once a day.
 * Shared by scheduled messages and jobs; new kinds join this union.
 */
export type Schedule = OnceSchedule | DailySchedule | WeeklySchedule | MonthlySchedule;
export type RecurringSchedule = Exclude<Schedule, OnceSchedule>;

/** The most runs a schedule may be limited to. */
export const MAX_SCHEDULE_COUNT = 10_000;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The first time the schedule runs strictly after `after`, or null when it
 * never runs again. Recurring kinds evaluate their rule in `timeZone`: a time
 * skipped when clocks go forward runs at the first minute after the gap, and a
 * time that happens twice runs at the first. `completed` is how many runs have
 * already been claimed, for schedules that end after a number of runs.
 */
export function nextOccurrence(schedule: Schedule, timeZone: string, after: Date, completed = 0): Date | null {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  if (schedule.end?.kind === "count" && completed >= schedule.end.count) return null;
  const until = schedule.end?.kind === "until" ? parseLocalDate(schedule.end.date) : undefined;
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  const start = zonedParts(after, timeZone);
  // A monthly schedule runs at least every 31 days; a few more cover the day `after` falls on.
  for (let offset = 0; offset <= 33; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const day = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    if (until !== undefined && Date.UTC(day.year, day.month - 1, day.day) > until) return null;
    if (!runsOn(schedule, day, date.getUTCDay())) continue;
    const at = zonedTime({ ...day, hour, minute }, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

function runsOn(schedule: RecurringSchedule, day: { year: number; month: number; day: number }, weekday: number) {
  switch (schedule.kind) {
    case "daily":
      return true;
    case "weekly":
      return schedule.weekdays.includes(weekday as Weekday);
    case "monthly":
      return day.day === Math.min(schedule.day, daysInMonth(day.year, day.month));
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A valid schedule with its instants in canonical UTC form, or undefined. */
export function normalizeSchedule(value: unknown): Schedule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === "once") {
    const at = isoTime(schedule.at);
    return at ? { kind: "once", at } : undefined;
  }
  if (typeof schedule.time !== "string" || !TIME_PATTERN.test(schedule.time)) return undefined;
  const time = schedule.time;
  let end: ScheduleEnd | undefined;
  if (schedule.end !== undefined) {
    end = normalizeScheduleEnd(schedule.end);
    if (!end) return undefined;
  }
  const ending = end ? { end } : {};
  switch (schedule.kind) {
    case "daily":
      return { kind: "daily", time, ...ending };
    case "weekly": {
      if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return undefined;
      if (!schedule.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return undefined;
      const weekdays = [...new Set(schedule.weekdays as Weekday[])].sort((a, b) => a - b);
      return { kind: "weekly", weekdays, time, ...ending };
    }
    case "monthly": {
      const day = schedule.day;
      if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) return undefined;
      return { kind: "monthly", day: day as number, time, ...ending };
    }
    default:
      return undefined;
  }
}

function normalizeScheduleEnd(value: unknown): ScheduleEnd | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const end = value as Record<string, unknown>;
  if (end.kind === "until") {
    return typeof end.date === "string" && parseLocalDate(end.date) !== undefined
      ? { kind: "until", date: end.date }
      : undefined;
  }
  if (end.kind === "count") {
    const count = end.count;
    return Number.isInteger(count) && (count as number) >= 1 && (count as number) <= MAX_SCHEDULE_COUNT
      ? { kind: "count", count: count as number }
      : undefined;
  }
  return undefined;
}

/** `YYYY-MM-DD` as a UTC midnight timestamp, or undefined when it is not a real date. */
function parseLocalDate(value: string): number | undefined {
  const match = DATE_PATTERN.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? time
    : undefined;
}

/** An ISO 8601 time with an explicit offset, as UTC; local times without an offset are ambiguous and refused. */
export function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * The schedule in words, for approval cards and for reading back to the
 * person: "Every Saturday at 09:00", "Every day at 10:00, 5 times".
 */
export function describeSchedule(schedule: Schedule, timeZone: string): string {
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  if (schedule.kind === "once") {
    const at = new Date(schedule.at).toLocaleString("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return `Once, on ${at} (${zone})`;
  }
  const time = `at ${schedule.time} (${zone})`;
  let rule: string;
  switch (schedule.kind) {
    case "daily":
      rule = `Every day ${time}`;
      break;
    case "weekly":
      rule =
        schedule.weekdays.length === 7
          ? `Every day ${time}`
          : `Every ${joinWords(schedule.weekdays.map((day) => WEEKDAY_NAMES[day] ?? ""))} ${time}`;
      break;
    case "monthly":
      rule =
        schedule.day > 28
          ? `On day ${schedule.day} of every month (or its last day) ${time}`
          : `On day ${schedule.day} of every month ${time}`;
      break;
  }
  if (!schedule.end) return rule;
  if (schedule.end.kind === "count") {
    return `${rule}, ${schedule.end.count === 1 ? "once" : `${schedule.end.count} times`}`;
  }
  const until = new Date(`${schedule.end.date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${rule}, until ${until}`;
}

function joinWords(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
