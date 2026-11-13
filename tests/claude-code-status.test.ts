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

  it("keeps a ready status when a later check cannot run claude, and checks again soon", async () => {
    const signedIn = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
    let now = 0;
    let versionChecks = 0;
    let answer: (args: ReadonlyArray<string>) => { stdout: string; exitCode: number } = (args) =>
      args[0] === "--version" ? { stdout: "2.1.303 (Claude Code)", exitCode: 0 } : { stdout: signedIn, exitCode: 0 };
    const timedOut = (): never => {
      throw new Error("spawn claude ETIMEDOUT");
    };
    const status = new ClaudeCodeStatusService({
      find: async () => "/usr/local/bin/claude",
      minimumVersion: async () => "2.1.276",
      now: () => now,
      runner: () => async (args) => {
        if (args[0] === "--version") versionChecks += 1;
        return answer(args);
      },
    });
    expect(await status.refresh()).toMatchObject({ state: "ready" });

    // A busy server: `claude --version` does not answer in time.
    now += 61_000;
    answer = timedOut;
    expect(await status.refresh()).toMatchObject({ state: "ready" });
    expect(status.current()).toMatchObject({ state: "ready" });

    // The sign-in check alone not answering does not sign the person out either.
    now += 6_000;
    answer = (args) => (args[0] === "--version" ? { stdout: "2.1.303 (Claude Code)", exitCode: 0 } : timedOut());
    expect(await status.refresh()).toMatchObject({ state: "ready" });
    expect(versionChecks).toBe(3);

    // An answer that says signed out is believed.
    now += 6_000;
    answer = (args) =>
      args[0] === "--version"
        ? { stdout: "2.1.303 (Claude Code)", exitCode: 0 }
        : { stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), exitCode: 1 };
    expect(await status.refresh()).toEqual({ state: "signed_out", version: "2.1.303" });
  });

  it("reports claude as missing when the first check cannot run it", async () => {
    const status = new ClaudeCodeStatusService({
      find: async () => "/usr/local/bin/claude",
      minimumVersion: async () => "2.1.276",
      runner: () => async () => {
        throw new Error("spawn claude ETIMEDOUT");
      },
    });
    expect(await status.refresh()).toEqual({ state: "missing" });
  });
});
