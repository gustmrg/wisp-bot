import { describe, expect, it } from "vitest";

import { ClaudeCodeStatusService } from "../backend/claude-code/claude-code-status.js";

function service() {
  return new ClaudeCodeStatusService({
    find: async () => "/usr/local/bin/claude",
    minimumVersion: async () => "2.1.276",
    runner: () => async (args) =>
      args[0] === "--version"
        ? { stdout: "2.1.303 (Claude Code)", exitCode: 0 }
        : { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }), exitCode: 0 },
  });
}

describe("ClaudeCodeStatusService", () => {
  it("adds the plan's usage the latest turn reported to a ready status", async () => {
    const status = service();
    expect(await status.refresh()).not.toHaveProperty("planUsage");

    status.recordPlanUsage({
      status: "allowed_warning",
      windows: {
        five_hour: { utilization: 0.9, resetsAt: 1792471200 },
        seven_day: { utilization: 0.2, resetsAt: 1792605600 },
      },
    });

    const expected = {
      limited: false,
      windows: [
        { window: "five_hour", utilization: 0.9, resetsAt: new Date(1792471200 * 1000).toISOString() },
        { window: "seven_day", utilization: 0.2, resetsAt: new Date(1792605600 * 1000).toISOString() },
      ],
    };
    expect(status.current()).toMatchObject({ state: "ready", planUsage: expected });
    expect(await status.refresh()).toMatchObject({ planUsage: expected });
    status.recordPlanUsage({ status: "rejected", windows: {} });
    expect(status.current()).toMatchObject({ planUsage: { limited: true, windows: [] } });
  });
});
