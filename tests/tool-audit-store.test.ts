import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ToolAuditStore } from "../electron/backend/tool-audit-store.js";

describe("ToolAuditStore", () => {
  it("appends ordered redacted records without retaining resource paths", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-tool-audit-"));
    const filePath = path.join(directory, "audit.jsonl");
    const audit = new ToolAuditStore(filePath);
    const base = {
      actionId: "action-1",
      conversationId: "one",
      toolCallId: "tool-1",
      category: "create_file" as const,
      scope: "secret/customer-list.txt",
      matchedPolicy: "ask" as const,
      timestamp: "2026-09-02T12:00:00.000Z",
    };

    audit.append({ ...base, decision: "ask", actor: "policy", outcome: "pending" });
    audit.append({ ...base, decision: "deny", actor: "user", outcome: "blocked" });

    const contents = await readFile(filePath, "utf8");
    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map(({ decision }) => decision)).toEqual(["ask", "deny"]);
    expect(records[0]).toMatchObject({ scope: "[REDACTED]", scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(contents).not.toContain("customer-list");
  });
});
