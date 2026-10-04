import { describe, expect, it } from "vitest";

import type { Message } from "@/chat-data";
import { chatActivityDate, chatActivityLabel, dateDividerLabel, withDateDividers } from "@/lib/date-dividers";

const now = new Date("2026-09-11T15:00:00");

const messages = {
  today: { type: "incoming", text: "Just now", createdAt: "2026-09-11T09:30:00" },
  todayLater: { type: "outgoing", text: "Reply", createdAt: "2026-09-11T21:05:00" },
  yesterday: { type: "incoming", text: "From yesterday", createdAt: "2026-09-10T22:10:00" },
  olderThisYear: { type: "incoming", text: "From September 8", createdAt: "2026-09-08T08:00:00" },
  previousYear: { type: "outgoing", text: "From last year", createdAt: "2025-06-01T10:00:00" },
  untimed: { type: "outgoing", text: "Legacy message" },
  invalid: { type: "incoming", text: "Broken clock", createdAt: "not-a-date" },
} satisfies Record<string, Message>;

function dividerTexts(result: ReadonlyArray<Message>): string[] {
  return result.filter((message) => message.type === "time").map((message) => message.text);
}

describe("dateDividerLabel", () => {
  it("uses relative labels for today and yesterday", () => {
    expect(dateDividerLabel(new Date("2026-09-11T00:05:00"), now)).toBe("Today");
    expect(dateDividerLabel(new Date("2026-09-10T23:59:00"), now)).toBe("Yesterday");
  });

  it("formats older messages as zero-padded DD/MM/YYYY", () => {
    expect(dateDividerLabel(new Date("2026-09-08T08:00:00"), now)).toBe("08/09/2026");
    expect(dateDividerLabel(new Date("2025-06-01T10:00:00"), now)).toBe("01/06/2025");
  });
});

describe("withDateDividers", () => {
  it("opens the transcript with a divider and splits on day changes", () => {
    const result = withDateDividers(
      [messages.today, messages.todayLater, messages.yesterday, messages.olderThisYear],
      now,
    );

    expect(dividerTexts(result)).toEqual(["Today", "Yesterday", "08/09/2026"]);
    expect(result.map((message) => message.type)).toEqual([
      "time",
      "incoming",
      "outgoing",
      "time",
      "incoming",
      "time",
      "incoming",
    ]);
  });

  it("adds dividers for messages from previous years too", () => {
    const result = withDateDividers([messages.previousYear], now);
    expect(dividerTexts(result)).toEqual(["01/06/2025"]);
  });

  it("skips messages without a usable timestamp", () => {
    const result = withDateDividers([messages.untimed, messages.invalid, messages.today], now);

    expect(dividerTexts(result)).toEqual(["Today"]);
    expect(result).toHaveLength(4);
  });

  it("gives dividers stable ids derived from the day", () => {
    const result = withDateDividers([messages.yesterday, messages.today], now);
    const ids = result.filter((message) => message.type === "time").map((message) => message.id);

    expect(ids).toEqual([expect.stringMatching(/^date:\d+$/), expect.stringMatching(/^date:\d+$/)]);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("chatActivityDate", () => {
  it("uses the last activity the backend recorded", () => {
    expect(chatActivityDate({ timestamp: "Now", lastActivityAt: messages.today.createdAt })).toEqual(
      new Date(messages.today.createdAt),
    );
  });

  it("falls back to an ISO chat timestamp and ignores legacy display strings", () => {
    expect(chatActivityDate({ timestamp: "2026-09-11T09:00:00.000Z" })).toEqual(new Date("2026-09-11T09:00:00.000Z"));
    expect(chatActivityDate({ timestamp: "Now" })).toBeNull();
    expect(chatActivityDate({ timestamp: "Yesterday", lastActivityAt: "not a date" })).toBeNull();
  });
});

describe("chatActivityLabel", () => {
  it("counts recent activity in minutes instead of showing a frozen 'Now'", () => {
    expect(chatActivityLabel(new Date("2026-09-11T14:59:40"), now)).toBe("Now");
    expect(chatActivityLabel(new Date("2026-09-11T14:55:00"), now)).toBe("5m");
  });

  it("shows the time today, then day names, then dates", () => {
    const earlierToday = new Date("2026-09-11T09:30:00");
    expect(chatActivityLabel(earlierToday, now)).toBe(
      earlierToday.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
    expect(chatActivityLabel(new Date("2026-09-10T22:10:00"), now)).toBe("Yesterday");
    const threeDaysAgo = new Date("2026-09-08T08:00:00");
    expect(chatActivityLabel(threeDaysAgo, now)).toBe(threeDaysAgo.toLocaleDateString([], { weekday: "short" }));
    expect(chatActivityLabel(new Date("2026-08-20T08:00:00"), now)).toBe("20/08");
    expect(chatActivityLabel(new Date("2025-06-01T10:00:00"), now)).toBe("01/06/2025");
  });
});
