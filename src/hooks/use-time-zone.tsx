import { createContext, useContext, useEffect, type ReactNode } from "react";

import { systemTimeZone } from "../../shared/time-zone";

const TimeZoneContext = createContext<string | null>(null);

/** Shows every date and time below it in `timeZone`. */
export function TimeZoneProvider({ timeZone, children }: { timeZone: string; children: ReactNode }) {
  return <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>;
}

/** The time zone dates and times are shown in: the person's choice, or this device's. */
export function useTimeZone(): string {
  return useContext(TimeZoneContext) ?? systemTimeZone();
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
