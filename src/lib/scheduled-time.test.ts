import { describe, expect, it } from "vitest";

import {
  formatScheduledTime,
  fromDateTimeLocalValue,
  schedulePresets,
  toDateTimeLocalValue,
} from "@/lib/scheduled-time";

describe("scheduled times", () => {
  it("suggests an hour from now, tomorrow morning, and Monday morning", () => {
    // A Saturday afternoon, local time.
    const now = new Date(2026, 9, 10, 15, 42, 30);
    expect(schedulePresets(now).map(({ label, at }) => [label, toDateTimeLocalValue(at)])).toEqual([
      ["In 1 hour", "2026-10-10T16:42"],
      ["Tomorrow morning", "2026-10-11T09:00"],
      ["Monday morning", "2026-10-12T09:00"],
    ]);
  });

  it("leaves out Monday when tomorrow is Monday, and means next week's Monday on a Monday", () => {
    const sunday = new Date(2026, 9, 11, 20, 0);
    expect(schedulePresets(sunday).map(({ label }) => label)).toEqual(["In 1 hour", "Tomorrow morning"]);
    const monday = new Date(2026, 9, 12, 8, 0);
    expect(toDateTimeLocalValue(schedulePresets(monday)[2]!.at)).toBe("2026-10-19T09:00");
  });

  it("names today and tomorrow, and dates further out", () => {
    const now = new Date(2026, 9, 10, 15, 0);
    expect(formatScheduledTime(new Date(2026, 9, 10, 18, 30), now)).toMatch(/^Today, /);
    expect(formatScheduledTime(new Date(2026, 9, 11, 9, 0), now)).toMatch(/^Tomorrow, /);
    expect(formatScheduledTime(new Date(2026, 9, 14, 9, 0), now)).not.toMatch(/^(Today|Tomorrow)/);
  });

  it("follows the given time zone for mornings, days, and datetime-local values", () => {
    // Saturday 23:30 in São Paulo, already Sunday in UTC.
    const now = new Date("2026-10-11T02:30:00Z");
    const presets = schedulePresets(now, "America/Sao_Paulo");
    expect(presets.map(({ label, at }) => [label, at.toISOString()])).toEqual([
      ["In 1 hour", "2026-10-11T03:30:00.000Z"],
      ["Tomorrow morning", "2026-10-11T12:00:00.000Z"],
      ["Monday morning", "2026-10-12T12:00:00.000Z"],
    ]);
    expect(formatScheduledTime(presets[1]!.at, now, "America/Sao_Paulo")).toMatch(/^Tomorrow, /);
    expect(toDateTimeLocalValue(now, "America/Sao_Paulo")).toBe("2026-10-10T23:30");
    expect(fromDateTimeLocalValue("2026-10-10T23:30", "America/Sao_Paulo")?.toISOString()).toBe(
      "2026-10-11T02:30:00.000Z",
    );
  });

  it("reads and writes datetime-local values in local time", () => {
    const date = new Date(2026, 0, 5, 7, 3);
    expect(toDateTimeLocalValue(date)).toBe("2026-01-05T07:03");
    expect(fromDateTimeLocalValue("2026-01-05T07:03")?.getTime()).toBe(date.getTime());
    expect(fromDateTimeLocalValue("")).toBeNull();
  });
});
