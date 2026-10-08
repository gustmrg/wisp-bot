import { describe, expect, it } from "vitest";

import { isTimeZone, zonedDayNumber, zonedParts, zonedTime } from "../shared/time-zone.js";

describe("time zones", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(3)).toBe(false);
  });

  it("reads the wall clock of an instant in a time zone", () => {
    const instant = new Date("2026-10-08T02:30:00Z");
    expect(zonedParts(instant, "America/Sao_Paulo")).toEqual({
      year: 2026,
      month: 10,
      day: 7,
      hour: 23,
      minute: 30,
      weekday: 3,
    });
    expect(zonedParts(instant, "Asia/Kolkata")).toMatchObject({ day: 8, hour: 8, minute: 0 });
    expect(zonedDayNumber(instant, "Asia/Kolkata") - zonedDayNumber(instant, "America/Sao_Paulo")).toBe(1);
  });

  it("finds the instant of a wall-clock time, across daylight saving changes and month ends", () => {
    expect(zonedTime({ year: 2026, month: 10, day: 7, hour: 23, minute: 30 }, "America/Sao_Paulo").toISOString()).toBe(
      "2026-10-08T02:30:00.000Z",
    );
    // New York: EDT (UTC-4) in July, EST (UTC-5) in December.
    expect(zonedTime({ year: 2026, month: 7, day: 1, hour: 9 }, "America/New_York").toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(zonedTime({ year: 2026, month: 12, day: 1, hour: 9 }, "America/New_York").toISOString()).toBe(
      "2026-12-01T14:00:00.000Z",
    );
    // The morning after the clocks went forward on March 8.
    expect(zonedTime({ year: 2026, month: 3, day: 8, hour: 9 }, "America/New_York").toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    );
    expect(zonedTime({ year: 2026, month: 1, day: 32, hour: 0 }, "UTC").toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});
