import { describe, expect, it } from "vitest";

import { formatClockTime } from "@/lib/clock-time";

describe("formatClockTime", () => {
  const morning = new Date("2026-09-11T09:05:00Z");
  const evening = new Date("2026-09-11T21:05:00Z");

  it("always pads the hour to two digits", () => {
    expect(formatClockTime(morning, "UTC")).toMatch(/^09:05/);
    expect(formatClockTime(morning, "UTC", "12h")).toMatch(/^09:05/);
  });

  it("uses a 24-hour or 12-hour clock when one is chosen", () => {
    expect(formatClockTime(evening, "UTC", "24h")).toBe("21:05");
    expect(formatClockTime(evening, "UTC", "12h")).toMatch(/^09:05\s?(PM|pm|p\.\s?m\.)$/);
  });

  it("shows the time in the given time zone", () => {
    expect(formatClockTime(evening, "America/Sao_Paulo", "24h")).toBe("18:05");
  });
});
