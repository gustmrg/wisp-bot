import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_POLICY, shouldRenewContext } from "../shared/context-policy.js";
import { parseContextRequest } from "../shared/validators.js";

describe("context renewal policy", () => {
  const now = new Date(2026, 8, 5, 10);
  const older = new Date(now.getTime() - 25 * 3600000).toISOString();
  it("requires both inactivity and a sufficiently large context", () => {
    expect(shouldRenewContext(DEFAULT_CONTEXT_POLICY, older, 12000, now)).toBe(true);
    expect(shouldRenewContext(DEFAULT_CONTEXT_POLICY, older, 11999, now)).toBe(false);
    expect(shouldRenewContext(DEFAULT_CONTEXT_POLICY, now.toISOString(), 20000, now)).toBe(false);
    expect(shouldRenewContext(DEFAULT_CONTEXT_POLICY, null, 20000, now)).toBe(false);
    expect(shouldRenewContext(DEFAULT_CONTEXT_POLICY, "invalid", 20000, now)).toBe(false);
    expect(shouldRenewContext({ ...DEFAULT_CONTEXT_POLICY, mode: "none" }, older, 20000, now)).toBe(false);
  });
  it("uses the latest local daily boundary, including before today's scheduled hour", () => {
    const policy = { ...DEFAULT_CONTEXT_POLICY, mode: "daily" as const };
    expect(shouldRenewContext(policy, new Date(2026, 8, 5, 3).toISOString(), 20000, now)).toBe(true);
    expect(shouldRenewContext(policy, new Date(2026, 8, 5, 5).toISOString(), 20000, now)).toBe(false);
    expect(shouldRenewContext(policy, new Date(2026, 8, 4, 5).toISOString(), 20000, new Date(2026, 8, 5, 3))).toBe(
      false,
    );
    expect(
      shouldRenewContext({ ...policy, mode: "both", idleHours: 1 }, new Date(2026, 8, 5, 5).toISOString(), 20000, now),
    ).toBe(true);
  });
  it("rejects malformed IPC actions, oversized memory and invalid policies", () => {
    for (const command of [
      { action: "delete" },
      { action: "get", extra: true },
      { action: "save", policy: DEFAULT_CONTEXT_POLICY, memory: "x".repeat(8001) },
      { action: "save", policy: { ...DEFAULT_CONTEXT_POLICY, idleHours: 0 }, memory: "" },
    ]) {
      expect(() => parseContextRequest({ conversationId: "one", command })).toThrow();
    }
    expect(
      parseContextRequest({
        conversationId: "one",
        command: { action: "save", policy: DEFAULT_CONTEXT_POLICY, memory: "Prefers concise responses" },
      }).command.action,
    ).toBe("save");
  });
});
