import { describe, expect, it } from "vitest";

import {
  compareVersions,
  detectClaudeCode,
  minimumClaudeCodeVersion,
  parseClaudeCodeVersion,
  type ClaudeCodeRunner,
} from "../backend/claude-code/claude-code-cli.js";

function runner(answers: Record<string, { stdout: string; exitCode?: number } | Error>): ClaudeCodeRunner {
  return async (args) => {
    const answer = answers[args.join(" ")];
    if (!answer) throw new Error(`Unexpected command: claude ${args.join(" ")}`);
    if (answer instanceof Error) throw answer;
    return { stdout: answer.stdout, exitCode: answer.exitCode ?? 0 };
  };
}

const signedIn = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "p@example.com",
  subscriptionType: "max",
});

describe("detectClaudeCode", () => {
  it("is ready with the plan when a recent claude is signed in", async () => {
    const status = await detectClaudeCode(
      runner({ "--version": { stdout: "2.1.303 (Claude Code)\n" }, "auth status --json": { stdout: signedIn } }),
      "2.1.276",
    );

    expect(status).toEqual({ state: "ready", version: "2.1.303", billing: "subscription", plan: "max" });
  });

  it("says when claude is missing, too old, or signed out", async () => {
    await expect(detectClaudeCode(runner({ "--version": new Error("ENOENT") }), "2.1.276")).resolves.toEqual({
      state: "missing",
    });
    await expect(
      detectClaudeCode(runner({ "--version": { stdout: "2.1.200 (Claude Code)" } }), "2.1.276"),
    ).resolves.toEqual({ state: "outdated", version: "2.1.200", minimumVersion: "2.1.276" });
    await expect(
      detectClaudeCode(
        runner({
          "--version": { stdout: "2.1.303 (Claude Code)" },
          // Signed out, `claude auth status` exits 1 and still prints its JSON.
          "auth status --json": { stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), exitCode: 1 },
        }),
        "2.1.276",
      ),
    ).resolves.toEqual({ state: "signed_out", version: "2.1.303" });
  });

  it("tells a Console API sign-in apart from a plan", async () => {
    const status = await detectClaudeCode(
      runner({
        "--version": { stdout: "2.1.303 (Claude Code)" },
        "auth status --json": { stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }) },
      }),
      "2.1.276",
    );

    expect(status).toEqual({ state: "ready", version: "2.1.303", billing: "api" });
  });
});

describe("versions", () => {
  it("parses and compares Claude Code versions", () => {
    expect(parseClaudeCodeVersion("2.1.303 (Claude Code)")).toBe("2.1.303");
    expect(parseClaudeCodeVersion("not a version")).toBeNull();
    expect(compareVersions("2.1.303", "2.1.276")).toBe(1);
    expect(compareVersions("2.1.276", "2.1.276")).toBe(0);
    expect(compareVersions("2.0.999", "2.1.0")).toBe(-1);
  });

  it("reads the minimum from the SDK Wisp ships", async () => {
    await expect(minimumClaudeCodeVersion()).resolves.toMatch(/^\d+\.\d+\.\d+$/);
  });
});
