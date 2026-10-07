import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextOccurrence, normalizeScheduledMessage } from "../backend/message-schedule.js";
import { parseScheduleMessageRequest, parseUpdateScheduledMessageRequest } from "../backend/validators.js";
import { newWisp, setupMessaging, START } from "./helpers/messaging-harness.js";

async function setup(options: Parameters<typeof setupMessaging>[0] = {}) {
  const harness = await setupMessaging(options);
  return { ...harness, views: harness.scheduleViews };
}

function inMinutes(minutes: number): string {
  return new Date(START.getTime() + minutes * 60_000).toISOString();
}

describe("MessageScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a one-off message at its time and then forgets it", async () => {
    const harness = await setup();
    harness.scheduler.start();
    const scheduled = await harness.scheduler.schedule({
      conversationId: "one",
      text: "Good morning",
      schedule: { kind: "once", at: inMinutes(90) },
      timeZone: "America/Sao_Paulo",
    });
    expect(scheduled.messages).toEqual([
      expect.objectContaining({ id: "scheduled-1", nextRunAt: inMinutes(90), sentCount: 0 }),
    ]);

    await harness.advance(89 * 60_000);
    expect(await harness.transcript()).toEqual([]);

    await harness.advance(60_000);
    await vi.waitFor(async () => {
      const messages = await harness.transcript();
      expect(messages[0]).toMatchObject({
        type: "outgoing",
        text: "Good morning",
        status: "complete",
        scheduled: { scheduledMessageId: "scheduled-1", scheduledAt: START.toISOString() },
      });
      expect(messages[1]).toMatchObject({ type: "incoming", status: "complete" });
    });
    expect((await harness.scheduler.getView()).messages).toEqual([]);
    expect(harness.views.at(-1)).toEqual({ messages: [] });
    await harness.close();
  });

  it("sends messages that came due while the backend was stopped once it starts", async () => {
    const first = await setup();
    await first.scheduler.schedule({
      conversationId: "one",
      text: "While you were away",
      schedule: { kind: "once", at: inMinutes(5) },
      timeZone: "UTC",
    });
    await first.close();

    const second = await setup({ directory: first.directory });
    await second.advance(60 * 60_000);
    expect(await second.transcript()).toEqual([]);
    second.scheduler.start();
    await second.advance(0);
    await vi.waitFor(async () => {
      expect((await second.transcript())[0]).toMatchObject({ type: "outgoing", text: "While you were away" });
    });
    expect((await second.scheduler.getView()).messages).toEqual([]);
    await second.close();
  });

  it("refuses times already past, but treats the last minute as now", async () => {
    const harness = await setup();
    harness.scheduler.start();
    await expect(
      harness.scheduler.schedule({
        conversationId: "one",
        text: "Too late",
        schedule: { kind: "once", at: inMinutes(-5) },
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await harness.scheduler.schedule({
      conversationId: "one",
      text: "Right away",
      schedule: { kind: "once", at: new Date(START.getTime() - 30_000).toISOString() },
      timeZone: "UTC",
    });
    await harness.advance(0);
    await vi.waitFor(async () => {
      expect((await harness.transcript())[0]).toMatchObject({ text: "Right away" });
    });
    await harness.close();
  });

  it("only schedules for Wisps that exist", async () => {
    const harness = await setup();
    await expect(
      harness.scheduler.schedule({
        conversationId: "missing",
        text: "Hello",
        schedule: { kind: "once", at: inMinutes(5) },
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await harness.close();
  });

  it("edits, reschedules, cancels, and sends early", async () => {
    const harness = await setup();
    harness.scheduler.start();
    const request = { conversationId: "one", timeZone: "UTC" };
    await harness.scheduler.schedule({ ...request, text: "First", schedule: { kind: "once", at: inMinutes(30) } });
    await harness.scheduler.schedule({ ...request, text: "Second", schedule: { kind: "once", at: inMinutes(10) } });

    const edited = await harness.scheduler.update({
      scheduledMessageId: "scheduled-1",
      text: "First, edited",
      schedule: { kind: "once", at: inMinutes(5) },
    });
    // Soonest first.
    expect(edited.messages.map(({ id, text, nextRunAt }) => ({ id, text, nextRunAt }))).toEqual([
      { id: "scheduled-1", text: "First, edited", nextRunAt: inMinutes(5) },
      { id: "scheduled-2", text: "Second", nextRunAt: inMinutes(10) },
    ]);

    const cancelled = await harness.scheduler.cancel("scheduled-1");
    expect(cancelled.messages.map(({ id }) => id)).toEqual(["scheduled-2"]);
    await harness.advance(6 * 60_000);
    expect(await harness.transcript()).toEqual([]);

    const sent = await harness.scheduler.sendNow("scheduled-2");
    expect(sent.messages).toEqual([]);
    await vi.waitFor(async () => {
      expect((await harness.transcript())[0]).toMatchObject({ text: "Second" });
    });
    // It is not sent again at its original time.
    await harness.advance(10 * 60_000);
    expect((await harness.transcript()).filter(({ type }) => type === "outgoing")).toHaveLength(1);

    await expect(harness.scheduler.cancel("scheduled-2")).rejects.toMatchObject({ code: "not_found" });
    await harness.close();
  });

  it("removes a Wisp's scheduled messages with the Wisp", async () => {
    const harness = await setup();
    await harness.service.createWisp(newWisp("two"), { notifyOnUpdatesEnabled: true });
    await harness.scheduler.schedule({
      conversationId: "two",
      text: "Never sent",
      schedule: { kind: "once", at: inMinutes(5) },
      timeZone: "UTC",
    });
    await harness.service.deleteWisp("two");

    expect(harness.removed).toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.views.at(-1)).toEqual({ messages: [] }));
    expect((await harness.scheduler.getView()).messages).toEqual([]);
    await harness.close();
  });

  it("keeps the message queued until the Wisp has a model to answer with", async () => {
    const harness = await setup({ model: null });
    harness.scheduler.start();
    await harness.scheduler.schedule({
      conversationId: "one",
      text: "Anyone there?",
      schedule: { kind: "once", at: inMinutes(1) },
      timeZone: "UTC",
    });
    await harness.advance(60_000);
    await vi.waitFor(async () => {
      expect((await harness.queue.getView()).messages).toEqual([
        expect.objectContaining({
          text: "Anyone there?",
          scheduled: expect.objectContaining({ scheduledMessageId: "scheduled-1" }),
        }),
      ]);
    });
    expect(await harness.transcript()).toEqual([]);

    await harness.service.applyModel({ providerId: "openai", modelId: "gpt-test" });
    await vi.waitFor(async () => {
      expect((await harness.transcript())[0]).toMatchObject({ text: "Anyone there?", status: "complete" });
    });
    expect((await harness.queue.getView()).messages).toEqual([]);
    await harness.close();
  });
});

describe("message schedules", () => {
  it("sends a one-off schedule once, at its time", () => {
    const schedule = { kind: "once", at: "2026-10-07T09:00:00.000Z" } as const;
    expect(nextOccurrence(schedule, "UTC", new Date("2026-10-07T08:59:59.000Z"))?.toISOString()).toBe(schedule.at);
    expect(nextOccurrence(schedule, "UTC", new Date(schedule.at))).toBeNull();
  });

  it("accepts times with an offset and known time zones only", () => {
    const request = {
      conversationId: "one",
      text: "Hello",
      schedule: { kind: "once", at: "2026-10-07T09:00:00-03:00" },
      timeZone: "America/Sao_Paulo",
    };
    expect(parseScheduleMessageRequest(request).schedule).toEqual({ kind: "once", at: "2026-10-07T12:00:00.000Z" });
    expect(() =>
      parseScheduleMessageRequest({ ...request, schedule: { kind: "once", at: "2026-10-07T09:00:00" } }),
    ).toThrow();
    expect(() => parseScheduleMessageRequest({ ...request, timeZone: "Mars/Olympus_Mons" })).toThrow();
    expect(() => parseScheduleMessageRequest({ ...request, schedule: { kind: "weekly" } })).toThrow();
    expect(() => parseScheduleMessageRequest({ ...request, text: "  " })).toThrow();
    expect(parseUpdateScheduledMessageRequest({ scheduledMessageId: "scheduled-1", text: "New" })).toEqual({
      scheduledMessageId: "scheduled-1",
      text: "New",
    });
  });

  it("skips stored records it cannot read", () => {
    expect(normalizeScheduledMessage({ id: "x", schedule: { kind: "someday" } })).toBeUndefined();
  });
});
