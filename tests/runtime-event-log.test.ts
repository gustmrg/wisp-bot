import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { debugPayload, RuntimeEventLog, type RuntimeEventLogOptions } from "../backend/runtime-event-log.js";

const AT = new Date("2026-10-30T12:00:00.000Z");
const directories: string[] = [];

async function createLog(options: Partial<RuntimeEventLogOptions> = {}) {
  const directory = options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "wisp-runtime-events-")));
  directories.push(directory);
  const log = new RuntimeEventLog({ now: () => AT, ...options, directory });
  await log.load();
  return { log, directory };
}

const lines = async (file: string) =>
  (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sequence: number; type: string; payload: unknown });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RuntimeEventLog", () => {
  it("keeps events only for a conversation that records, in a file of its own", async () => {
    const { log, directory } = await createLog();
    log.record("one", "pi", { type: "agent_start" });
    await expect(log.read("one")).resolves.toEqual({
      conversationId: "one",
      recording: false,
      events: [],
      dropped: false,
    });

    await expect(log.setRecording("one", true)).resolves.toMatchObject({ recording: true, events: [] });
    log.record("one", "pi", { type: "agent_start" }, "wisp-1");
    log.record("two", "pi", { type: "agent_start" });
    log.record("one", "claude-code", { kind: "no type" });

    const expected = [
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
    ];
    expect((await log.read("one")).events).toEqual(expected);
    expect((await log.read("two")).recording).toBe(false);
    expect(await lines(path.join(directory, "one.jsonl"))).toEqual(expected);
    expect((await readdir(directory)).sort()).toEqual(["one.jsonl", "recording.json"]);

    // Turning it off stops recording and keeps what was recorded.
    await expect(log.setRecording("one", false)).resolves.toMatchObject({ recording: false, events: expected });
    log.record("one", "pi", { type: "agent_end" });
    expect((await log.read("one")).events).toHaveLength(2);
    expect(log.isRecording("one")).toBe(false);
  });

  it("goes on recording after a restart, with the events and sequences it had", async () => {
    const first = await createLog();
    await first.log.setRecording("one", true);
    log3(first.log);
    await first.log.flush();

    const { log } = await createLog({ directory: first.directory });
    expect(log.isRecording("one")).toBe(true);
    log.record("one", "pi", { type: "event-4" });
    const view = await log.read("one");
    expect(view.recording).toBe(true);
    expect(view.events.map(({ sequence, type }) => [sequence, type])).toEqual([
      [1, "event-1"],
      [2, "event-2"],
      [3, "event-3"],
      [4, "event-4"],
    ]);
    expect((await log.read("one", 3)).events.map(({ type }) => type)).toEqual(["event-4"]);
  });

  it("keeps the newest events for the view and rotates the file at its size", async () => {
    const { log, directory } = await createLog({ maxEvents: 3, maxFileBytes: 400 });
    await log.setRecording("one", true);
    for (let index = 1; index <= 5; index++) log.record("one", "fake", { type: `event-${index}` });

    const view = await log.read("one");
    expect(view.events.map(({ type }) => type)).toEqual(["event-3", "event-4", "event-5"]);
    expect(view.dropped).toBe(true);
    expect((await log.read("one", 4)).events.map(({ sequence }) => sequence)).toEqual([5]);
    expect((await log.read("one", 5)).events).toEqual([]);

    // Each line is about 110 bytes: the fourth would pass 400, so the first three moved to `.1`.
    const sequences = async (name: string) => (await lines(path.join(directory, name))).map(({ sequence }) => sequence);
    expect(await sequences("one.jsonl.1")).toEqual([1, 2, 3]);
    expect(await sequences("one.jsonl")).toEqual([4, 5]);
    const contents = (await log.contents("one")).toString("utf8").split("\n").filter(Boolean);
    expect(contents.map((line) => (JSON.parse(line) as { sequence: number }).sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("masks the values of saved credentials wherever they appear", async () => {
    let secrets = ["sk-saved-model-key", "short"];
    const { log } = await createLog({ secretValues: async () => secrets });
    await log.setRecording("one", true);
    log.record("one", "pi", {
      type: "message_update",
      text: `Using sk-saved-model-key and short words, then ${"x".repeat(1_990)}sk-saved-model-key`,
      nested: [{ header: "Bearer sk-saved-model-key" }],
    });
    const [event] = (await log.read("one")).events;
    expect(JSON.stringify(event)).not.toContain("sk-saved-model-key");
    expect(event?.payload).toMatchObject({
      text: expect.stringMatching(/^Using \[redacted\] and short words/),
      nested: [{ header: "Bearer [redacted]" }],
    });

    // A credential saved later is masked once recording starts again.
    secrets = ["oauth-token-saved-later"];
    await log.setRecording("one", false);
    await log.setRecording("one", true);
    log.record("one", "claude-code", { type: "system", value: "oauth-token-saved-later" });
    expect((await log.read("one")).events.at(-1)?.payload).toEqual({ type: "system", value: "[redacted]" });
  });

  it("clears a conversation's file, and deletes those of conversations that are gone", async () => {
    const { log, directory } = await createLog();
    await log.setRecording("one", true);
    await log.setRecording("two", true);
    log.record("one", "pi", { type: "agent_start" });
    log.record("two", "pi", { type: "agent_start" });
    await writeFile(path.join(directory, "gone.jsonl.1"), "{}\n");
    await log.flush();
    expect(await log.measure()).toBeGreaterThan(0);

    await expect(log.clear("one")).resolves.toMatchObject({ recording: true, events: [] });
    expect((await readdir(directory)).sort()).toEqual(["gone.jsonl.1", "recording.json", "two.jsonl"]);
    log.record("one", "pi", { type: "agent_end" });
    expect((await log.read("one")).events.map(({ sequence }) => sequence)).toEqual([2]);

    await log.reconcile(new Set(["one"]));
    expect((await readdir(directory)).sort()).toEqual(["one.jsonl", "recording.json"]);
    expect(log.isRecording("two")).toBe(false);
    expect(JSON.parse(await readFile(path.join(directory, "recording.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      conversations: ["one"],
    });
  });
});

function log3(log: RuntimeEventLog) {
  for (let index = 1; index <= 3; index++) log.record("one", "pi", { type: `event-${index}` });
}

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
