import { describe, expect, it } from "vitest";

import {
  applyWispChanges,
  normalizeChatChanges,
  normalizeMessage,
  normalizeWispChanges,
} from "../backend/conversation-normalizer.js";

describe("normalizeChatChanges", () => {
  it("takes who answers only for a circle, and only known values", () => {
    expect(normalizeChatChanges({ kind: "circle", responder: "auto" })).toEqual({ kind: "circle", responder: "auto" });
    expect(normalizeChatChanges({ kind: "circle", responder: "lead" })).toEqual({ kind: "circle", responder: "lead" });
    expect(() => normalizeChatChanges({ kind: "circle", responder: "everyone" })).toThrow();
    expect(() => normalizeChatChanges({ kind: "wisp", responder: "auto" })).toThrow();
  });
});

describe("normalizeMessage", () => {
  it("keeps that the decision model chose a reply's author, only on a reply", () => {
    const reply = { id: "r", type: "incoming", text: "Hi", status: "complete", chosenAutomatically: true };
    expect(normalizeMessage(reply)).toMatchObject({ chosenAutomatically: true });
    expect(normalizeMessage({ ...reply, type: "outgoing" })).not.toHaveProperty("chosenAutomatically");
  });

  it("keeps why a Wisp's reply failed", () => {
    const error = { code: "model_unavailable", message: "The provider is out of credits." };
    expect(normalizeMessage({ id: "r", type: "incoming", text: "", status: "failed", error })).toMatchObject({
      text: "",
      error,
    });
  });

  it("loads replies saved before failures had a reason of their own", () => {
    expect(normalizeMessage({ id: "r", type: "incoming", text: "Wisp stopped.", status: "failed" })).not.toHaveProperty(
      "error",
    );
  });

  it("drops a reason on the person's own message and rejects a malformed one", () => {
    const error = { code: "aborted", message: "Stopped." };
    expect(normalizeMessage({ id: "o", type: "outgoing", text: "Hi", status: "failed", error })).not.toHaveProperty(
      "error",
    );
    expect(() => normalizeMessage({ id: "r", type: "incoming", text: "", error: { code: "aborted" } })).toThrow();
    expect(() => normalizeMessage({ id: "r", type: "incoming", text: "", error: "Stopped." })).toThrow();
  });

  it("keeps a reply's steps, leaving out a step that does not load rather than the message", () => {
    const base = { toolName: "read", status: "completed", startedAt: "2026-10-22T10:00:00.000Z" };
    const steps = [
      { ...base, id: "a", type: "file_read", paths: ["a.ts"], extra: "dropped" },
      { ...base, id: "b", toolName: "run_command", type: "command_execution", command: "npm test", exitCode: 1 },
      { ...base, id: "c", type: "file_read", paths: "a.ts" },
      { ...base, id: "d", status: "paused", type: "tool" },
      // A kind a newer version wrote shows as a plain tool call.
      { ...base, id: "e", toolName: "deploy", type: "deployment", target: "prod" },
    ];
    const message = normalizeMessage({ id: "r:work", type: "incoming", text: "", steps });

    expect(message).toMatchObject({
      steps: [
        { id: "a", type: "file_read", paths: ["a.ts"] },
        { id: "b", type: "command_execution", command: "npm test", exitCode: 1 },
        { id: "e", toolName: "deploy", type: "tool" },
      ],
    });
    expect(message.type === "incoming" && message.steps?.[0]).not.toHaveProperty("extra");
    expect(message.type === "incoming" && message.steps?.[2]).not.toHaveProperty("target");
  });

  it("keeps steps only on a Wisp's messages, and none when none load", () => {
    const steps = [
      { id: "a", toolName: "read", status: "completed", startedAt: "2026-10-22T10:00:00.000Z", type: "tool" },
    ];
    expect(normalizeMessage({ id: "o", type: "outgoing", text: "Hi", steps })).not.toHaveProperty("steps");
    expect(normalizeMessage({ id: "r", type: "incoming", text: "", steps: [{ id: "a" }] })).not.toHaveProperty("steps");
    expect(normalizeMessage({ id: "r", type: "incoming", text: "", steps: "a" })).not.toHaveProperty("steps");
  });
});

describe("normalizeWispChanges", () => {
  it("turns a Wisp's memory off and on, and rejects anything but a boolean (SWE-228)", () => {
    expect(normalizeWispChanges({ memoryOff: true })).toEqual({ memoryOff: true });
    expect(normalizeWispChanges({ memoryOff: false })).toEqual({ memoryOff: false });
    expect(() => normalizeWispChanges({ memoryOff: "yes" })).toThrow();
    const wisp = {
      id: "one",
      name: "Atlas",
      role: "",
      soul: "",
      appearance: {
        body: "round",
        trail: "none",
        tone: "plain",
        eyes: "dots",
        eyeInk: "dark",
        finish: "solid",
        mark: "none",
      },
    } as never;
    const off = applyWispChanges(wisp, { memoryOff: true });
    expect(off).toMatchObject({ memoryOff: true });
    // Memory on is the default, so the field is left out rather than stored as false.
    expect(applyWispChanges(off, { memoryOff: false })).not.toHaveProperty("memoryOff");
  });
});
