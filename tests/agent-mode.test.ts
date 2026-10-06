import { describe, expect, it } from "vitest";

import { selectAgentMode } from "../backend/agent-mode.js";

describe("selectAgentMode", () => {
  it("allows the explicit fake adapter only in unpackaged development", () => {
    expect(selectAgentMode(false, "fake")).toBe("fake");
    expect(selectAgentMode(false, undefined)).toBe("pi");
    expect(selectAgentMode(false, "FAKE")).toBe("pi");
  });

  it("always uses Pi in packaged builds", () => {
    expect(selectAgentMode(true, "fake")).toBe("pi");
  });
});
