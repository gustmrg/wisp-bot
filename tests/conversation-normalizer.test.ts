import { describe, expect, it } from "vitest";

import { normalizeMessage } from "../backend/conversation-normalizer.js";

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
