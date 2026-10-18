/** How clock times read: the locale's own convention, always 24-hour, or always AM/PM. */
export type TimeFormat = "auto" | "24h" | "12h";

export const TIME_FORMATS: ReadonlyArray<TimeFormat> = ["auto", "24h", "12h"];

/** The hour and minute options for a clock time, with a zero-padded hour ("09:05"). */
export function clockTimeOptions(format: TimeFormat = "auto"): Intl.DateTimeFormatOptions {
  return {
    hour: "2-digit",
    minute: "2-digit",
    ...(format === "24h" ? { hourCycle: "h23" } : format === "12h" ? { hourCycle: "h12" } : {}),
  };
}

/** "09:05", "21:05" or "09:05 PM", in `timeZone`. */
export function formatClockTime(date: Date, timeZone: string, format: TimeFormat = "auto"): string {
  return date.toLocaleTimeString([], { ...clockTimeOptions(format), timeZone });
}
