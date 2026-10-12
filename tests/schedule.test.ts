import { describe, expect, it } from "vitest";

import { describeSchedule, nextOccurrence, normalizeSchedule, type Schedule } from "../shared/schedule.js";

function next(schedule: Schedule, timeZone: string, after: string, completed = 0): string | undefined {
  return nextOccurrence(schedule, timeZone, new Date(after), completed)?.toISOString();
}

describe("schedules", () => {
  it("runs daily at a local time, in the schedule's time zone", () => {
    const schedule: Schedule = { kind: "daily", time: "10:00" };
    // 10:00 in São Paulo (UTC-3) is 13:00 UTC.
    expect(next(schedule, "America/Sao_Paulo", "2026-10-11T12:00:00Z")).toBe("2026-10-11T13:00:00.000Z");
    expect(next(schedule, "America/Sao_Paulo", "2026-10-11T13:00:00Z")).toBe("2026-10-12T13:00:00.000Z");
    // Late evening UTC is still the same day in São Paulo.
    expect(next(schedule, "America/Sao_Paulo", "2026-10-12T01:00:00Z")).toBe("2026-10-12T13:00:00.000Z");
  });

  it("runs weekly on the chosen weekdays", () => {
    const schedule: Schedule = { kind: "weekly", weekdays: [1, 6], time: "09:00" };
    // Sunday, October 11, 2026.
    expect(next(schedule, "UTC", "2026-10-11T12:00:00Z")).toBe("2026-10-12T09:00:00.000Z");
    expect(next(schedule, "UTC", "2026-10-12T09:00:00Z")).toBe("2026-10-17T09:00:00.000Z");
  });

  it("runs monthly, on the last day of months without the chosen day", () => {
    const schedule: Schedule = { kind: "monthly", day: 31, time: "08:00" };
    expect(next(schedule, "UTC", "2026-10-31T08:00:00Z")).toBe("2026-11-30T08:00:00.000Z");
    expect(next(schedule, "UTC", "2027-01-31T08:00:00Z")).toBe("2027-02-28T08:00:00.000Z");
    expect(next(schedule, "UTC", "2028-01-31T08:00:00Z")).toBe("2028-02-29T08:00:00.000Z");
    expect(next({ kind: "monthly", day: 15, time: "08:00" }, "UTC", "2026-10-15T08:00:00Z")).toBe(
      "2026-11-15T08:00:00.000Z",
    );
  });

  it("runs a time skipped by daylight saving at the first minute after it, and a repeated time once", () => {
    // New York skips 02:00-03:00 on March 8, 2026, and repeats 01:00-02:00 on November 1.
    expect(next({ kind: "daily", time: "02:30" }, "America/New_York", "2026-03-08T00:00:00Z")).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(next({ kind: "daily", time: "01:30" }, "America/New_York", "2026-11-01T00:00:00Z")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(next({ kind: "daily", time: "01:30" }, "America/New_York", "2026-11-01T05:30:00Z")).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("stops after its end date or number of runs", () => {
    const until: Schedule = { kind: "daily", time: "10:00", end: { kind: "until", date: "2026-10-12" } };
    expect(next(until, "UTC", "2026-10-11T12:00:00Z")).toBe("2026-10-12T10:00:00.000Z");
    expect(next(until, "UTC", "2026-10-12T10:00:00Z")).toBeUndefined();

    const count: Schedule = { kind: "daily", time: "10:00", end: { kind: "count", count: 2 } };
    expect(next(count, "UTC", "2026-10-11T12:00:00Z", 1)).toBe("2026-10-12T10:00:00.000Z");
    expect(next(count, "UTC", "2026-10-12T10:00:00Z", 2)).toBeUndefined();
  });

  it("runs a one-off schedule once", () => {
    const schedule: Schedule = { kind: "once", at: "2026-10-12T10:00:00.000Z" };
    expect(next(schedule, "UTC", "2026-10-11T12:00:00Z")).toBe(schedule.at);
    expect(next(schedule, "UTC", schedule.at)).toBeUndefined();
  });

  it("accepts only well-formed schedules", () => {
    expect(normalizeSchedule({ kind: "weekly", weekdays: [6, 1, 6], time: "09:00" })).toEqual({
      kind: "weekly",
      weekdays: [1, 6],
      time: "09:00",
    });
    expect(normalizeSchedule({ kind: "once", at: "2026-10-12T10:00:00-03:00" })).toEqual({
      kind: "once",
      at: "2026-10-12T13:00:00.000Z",
    });
    expect(normalizeSchedule({ kind: "daily", time: "10:00", end: { kind: "until", date: "2026-12-31" } })).toEqual({
      kind: "daily",
      time: "10:00",
      end: { kind: "until", date: "2026-12-31" },
    });
    for (const invalid of [
      { kind: "daily", time: "24:00" },
      { kind: "daily", time: "9:00" },
      { kind: "weekly", weekdays: [], time: "09:00" },
      { kind: "weekly", weekdays: [7], time: "09:00" },
      { kind: "monthly", day: 0, time: "09:00" },
      { kind: "monthly", day: 32, time: "09:00" },
      { kind: "daily", time: "10:00", end: { kind: "until", date: "2026-02-30" } },
      { kind: "daily", time: "10:00", end: { kind: "count", count: 0 } },
      { kind: "once", at: "2026-10-12T10:00:00" },
      { kind: "hourly", time: "10:00" },
      "daily",
    ]) {
      expect(normalizeSchedule(invalid)).toBeUndefined();
    }
  });

  it("describes schedules in words", () => {
    expect(describeSchedule({ kind: "daily", time: "10:00" }, "America/Sao_Paulo")).toBe(
      "Every day at 10:00 (America/Sao_Paulo)",
    );
    expect(describeSchedule({ kind: "weekly", weekdays: [1, 3, 5], time: "08:00" }, "UTC")).toBe(
      "Every Monday, Wednesday and Friday at 08:00 (UTC)",
    );
    expect(describeSchedule({ kind: "monthly", day: 31, time: "08:00", end: { kind: "count", count: 3 } }, "UTC")).toBe(
      "On day 31 of every month (or its last day) at 08:00 (UTC), 3 times",
    );
    expect(
      describeSchedule(
        { kind: "weekly", weekdays: [6], time: "09:00", end: { kind: "until", date: "2026-12-31" } },
        "UTC",
      ),
    ).toBe("Every Saturday at 09:00 (UTC), until Dec 31, 2026");
    expect(describeSchedule({ kind: "once", at: "2026-10-17T13:00:00.000Z" }, "America/Sao_Paulo")).toBe(
      "Once, on Sat, Oct 17, 2026, 10:00 (America/Sao_Paulo)",
    );
  });
});
