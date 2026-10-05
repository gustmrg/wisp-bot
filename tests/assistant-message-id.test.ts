import { describe, expect, it } from "vitest";

import { assistantMessageId, requestIdOfAssistantMessage } from "../shared/conversations.js";

describe("assistant message IDs", () => {
  it("keeps the original ID for the first part and numbers later parts", () => {
    expect(assistantMessageId("request-1")).toBe("request-1:assistant");
    expect(assistantMessageId("request-1", 3)).toBe("request-1:assistant:3");
  });

  it("finds the request a reply part answers", () => {
    expect(requestIdOfAssistantMessage("request-1:assistant")).toBe("request-1");
    expect(requestIdOfAssistantMessage("request-1:assistant:2")).toBe("request-1");
    expect(requestIdOfAssistantMessage("request-1")).toBeNull();
    expect(requestIdOfAssistantMessage("context:2026-01-01")).toBeNull();
  });
});
