import { createContext, useContext, useEffect, type ReactNode } from "react";

import type { TimeFormat } from "@/lib/clock-time";
import { systemTimeZone } from "../../shared/time-zone";

const TimeZoneContext = createContext<string | null>(null);
const TimeFormatContext = createContext<TimeFormat>("auto");

/** Shows every date and time below it in `timeZone`, with clock times in `timeFormat`. */
export function TimeZoneProvider({
  timeZone,
  timeFormat = "auto",
  children,
}: {
  timeZone: string;
  timeFormat?: TimeFormat;
  children: ReactNode;
}) {
  return (
    <TimeZoneContext.Provider value={timeZone}>
      <TimeFormatContext.Provider value={timeFormat}>{children}</TimeFormatContext.Provider>
    </TimeZoneContext.Provider>
  );
}

/** The time zone dates and times are shown in: the person's choice, or this device's. */
export function useTimeZone(): string {
  return useContext(TimeZoneContext) ?? systemTimeZone();
}

/** How clock times read: the person's choice, or the locale's convention. */
export function useTimeFormat(): TimeFormat {
  return useContext(TimeFormatContext);
}

/**
 * Tells the server which time zone the person is in, now and whenever it
 * changes, so Wisps know their local time. An older server that cannot store
 * it keeps using its own.
 */
export function useReportedTimeZone(timeZone: string): void {
  useEffect(() => {
    void window.wisp.setUserTimeZone({ timeZone }).catch(() => undefined);
  }, [timeZone]);
}
