import { describe, expect, it } from "vitest";

import { DEMO_CURRENT_USER } from "@/fixtures/demo-session";

describe("demo session", () => {
  it("provides the existing demo identity through one immutable fixture", () => {
    expect(DEMO_CURRENT_USER).toEqual({
      displayName: "John Doe",
      email: "john.doe@example.com",
      givenName: "John",
      initials: "JD",
    });
    expect(Object.isFrozen(DEMO_CURRENT_USER)).toBe(true);
  });
});
