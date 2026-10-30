import { describe, expect, it } from "vitest";

import { debugPayload, RuntimeEventLog } from "../backend/runtime-event-log.js";

const AT = new Date("2026-10-30T12:00:00.000Z");

describe("RuntimeEventLog", () => {
  it("keeps events only for a conversation that records, and forgets them when recording stops", () => {
    const log = new RuntimeEventLog({ now: () => AT });
    log.record("one", "pi", { type: "agent_start" });
    expect(log.read("one")).toEqual({ conversationId: "one", recording: false, events: [], dropped: false });

    expect(log.setRecording("one", true)).toMatchObject({ recording: true, events: [] });
    log.record("one", "pi", { type: "agent_start" }, "wisp-1");
    log.record("two", "pi", { type: "agent_start" });
    log.record("one", "claude-code", { kind: "no type" });

    expect(log.read("one").events).toEqual([
      {
        sequence: 1,
        wispId: "wisp-1",
        runtime: "pi",
        type: "agent_start",
        receivedAt: AT.toISOString(),
        payload: { type: "agent_start" },
      },
      {
        sequence: 2,
        runtime: "claude-code",
        type: "unknown",
        receivedAt: AT.toISOString(),
        payload: { kind: "no type" },
      },
    ]);
    expect(log.read("two").recording).toBe(false);

    expect(log.setRecording("one", false)).toMatchObject({ recording: false, events: [] });
    expect(log.isRecording("one")).toBe(false);
  });

  it("returns only the events after a sequence, and keeps the newest within its limit", () => {
    const log = new RuntimeEventLog({ maxEvents: 3 });
    log.setRecording("one", true);
    for (let index = 1; index <= 5; index++) log.record("one", "fake", { type: `event-${index}` });

    const view = log.read("one");
    expect(view.events.map(({ type }) => type)).toEqual(["event-3", "event-4", "event-5"]);
    expect(view.dropped).toBe(true);
    expect(log.read("one", 4).events.map(({ sequence }) => sequence)).toEqual([5]);
    expect(log.read("one", 5).events).toEqual([]);

    log.forget("one");
    expect(log.isRecording("one")).toBe(false);
  });
});

describe("debugPayload", () => {
  it("removes credentials wherever they appear", () => {
    expect(
      debugPayload({
        type: "system",
        apiKey: "sk-secret",
        options: { headers: { Authorization: "Bearer secret", "x-request-id": "r1" }, access_token: "t" },
        token: "",
        usage: { input_tokens: 10 },
      }),
    ).toEqual({
      type: "system",
      apiKey: "[redacted]",
      options: { headers: { Authorization: "[redacted]", "x-request-id": "r1" }, access_token: "[redacted]" },
      token: "",
      usage: { input_tokens: 10 },
    });
  });

  it("turns any value into bounded JSON", () => {
    const cycle: Record<string, unknown> = { type: "loop" };
    cycle.self = cycle;
    const shared = { name: "shared" };
    const payload = debugPayload({
      cycle,
      twice: [shared, shared],
      text: "x".repeat(2_500),
      error: new Error("failed"),
      bytes: new Uint8Array(8),
      fn: () => undefined,
      big: 10n,
      nan: Number.NaN,
    }) as Record<string, unknown>;

    expect(payload.cycle).toEqual({ type: "loop", self: "[circular]" });
    expect(payload.twice).toEqual([{ name: "shared" }, { name: "shared" }]);
    expect(payload.text).toBe(`${"x".repeat(2_000)}… (2500 characters)`);
    expect(payload.error).toEqual({ name: "Error", message: "failed" });
    expect(payload.bytes).toBe("[8 bytes]");
    expect("fn" in payload).toBe(false);
    expect(payload.big).toBe("10");
    expect(payload.nan).toBe("NaN");
  });

  it("cuts deep nesting and replaces a payload too large to keep", () => {
    let nested: unknown = "bottom";
    for (let depth = 0; depth < 20; depth++) nested = { nested };
    expect(JSON.stringify(debugPayload(nested))).toContain("[nested too deep]");

    const large = debugPayload({ parts: Array.from({ length: 20 }, () => "y".repeat(1_500)) }) as Record<
      string,
      unknown
    >;
    expect(large).toMatchObject({ truncated: true });
    expect((large.preview as string).length).toBe(16_000);
  });
});
