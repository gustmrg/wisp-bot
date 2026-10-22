import { describe, expect, it } from "vitest";

import {
  applyWispChanges,
  normalizeMessage,
  normalizeWisp,
  normalizeWispChanges,
} from "../backend/conversation-normalizer.js";
import { MESSAGE_REASONING_MAX_LENGTH } from "../shared/conversations.js";
import { DEFAULT_WISP_APPEARANCE } from "../shared/wisp-appearance.js";

describe("normalizeMessage", () => {
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
});

describe("reasoning", () => {
  it("keeps a reply's reasoning, bounded, and never on the person's own message", () => {
    expect(normalizeMessage({ id: "r", type: "incoming", text: "Hi", reasoning: "First, greet." })).toMatchObject({
      reasoning: "First, greet.",
    });
    expect(normalizeMessage({ id: "o", type: "outgoing", text: "Hi", reasoning: "x" })).not.toHaveProperty("reasoning");
    expect(() =>
      normalizeMessage({
        id: "r",
        type: "incoming",
        text: "",
        reasoning: "x".repeat(MESSAGE_REASONING_MAX_LENGTH + 1),
      }),
    ).toThrow();
    expect(() => normalizeMessage({ id: "r", type: "incoming", text: "", reasoning: 1 })).toThrow();
  });

  it("stores a Wisp's display choices only while they are on", () => {
    const wisp = normalizeWisp({ id: "one", name: "One", role: "", soul: "", appearance: DEFAULT_WISP_APPEARANCE });
    expect(wisp).not.toHaveProperty("showReasoning");
    const showing = applyWispChanges(wisp, normalizeWispChanges({ showReasoning: true }));
    expect(showing.showReasoning).toBe(true);
    expect(normalizeWisp(showing).showReasoning).toBe(true);
    expect(applyWispChanges(showing, normalizeWispChanges({ showReasoning: false }))).not.toHaveProperty(
      "showReasoning",
    );
    expect(() => normalizeWispChanges({ showReasoning: "yes" })).toThrow();
    const verbose = applyWispChanges(wisp, normalizeWispChanges({ verboseSteps: true }));
    expect(normalizeWisp(verbose).verboseSteps).toBe(true);
    expect(applyWispChanges(verbose, { verboseSteps: false })).not.toHaveProperty("verboseSteps");
  });
});
