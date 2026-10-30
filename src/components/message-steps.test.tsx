import { describe, expect, it } from "vitest";

import { summarizeSteps, viewOfStep } from "@/components/message-steps";
import type { TurnItem } from "../../shared/contracts";

function tool(toolName: string, status: TurnItem["status"], extra: Partial<TurnItem> = {}): TurnItem {
  return { id: "1", toolName, status, startedAt: "2026-10-22T10:00:00.000Z", type: "tool", ...extra } as TurnItem;
}

describe("how a step names its tool", () => {
  it("says what a running tool is doing in the header's words, and what it was once done", () => {
    expect(viewOfStep(tool("linear_create_issue", "running")).verb).toBe("Creating a Linear issue");
    expect(viewOfStep(tool("linear_create_issue", "completed")).verb).toBe("Create Linear issue");
  });

  it("uses the words the backend sends for an MCP tool", () => {
    const words = { toolLabel: "Get entry", label: "Calling Get entry…" };
    expect(viewOfStep(tool("mcp_ee86e536b696_getentry", "running", words)).verb).toBe("Calling Get entry");
    expect(viewOfStep(tool("mcp_ee86e536b696_getentry", "completed", { toolLabel: "Get entry" })).verb).toBe(
      "Get entry",
    );
    expect(summarizeSteps([tool("mcp_ee86e536b696_getentry", "completed", { toolLabel: "Get entry" })])).toBe(
      "Get entry",
    );
  });

  it("puts a tool it does not know in words, without showing the identifier", () => {
    expect(viewOfStep(tool("getEntry", "running")).verb).toBe("Get entry");
    expect(viewOfStep(tool("get_entry", "completed")).verb).toBe("Get entry");
  });
});
