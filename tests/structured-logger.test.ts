import { describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "../electron/backend/structured-logger.js";

describe("StructuredLogger", () => {
  it("redacts sensitive keys and secret-shaped values", () => {
    const info = vi.fn();
    const logger = new StructuredLogger({ info, warn: vi.fn() });

    logger.info("provider_event", {
      conversationId: "one",
      apiKey: "sk-super-secret-value",
      nested: { authorization: "Bearer abc.def.ghi", safe: "sk-anothersecret" },
    });

    const serialized = String(info.mock.calls[0]?.[0]);
    expect(serialized).toContain("conversationId");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("abc.def");
    expect(serialized).not.toContain("anothersecret");
  });
});
