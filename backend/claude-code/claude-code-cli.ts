import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { claudeCodeEnvironment, parseClaudeCodeAuthStatus, type ClaudeCodeAuthStatus } from "./claude-code-launch.js";

const COMMAND_TIMEOUT_MS = 10_000;

/** Whether this server can run Claude Code Wisps, and why not when it cannot (ADR 026). */
export type ClaudeCodeStatus =
  | { state: "missing" }
  | { state: "outdated"; version: string; minimumVersion: string }
  | { state: "signed_out"; version: string }
  /** `billing` says who pays: the person's Claude plan, or their Anthropic API account. */
  | { state: "ready"; version: string; billing: "subscription" | "api"; plan?: string };

/** Runs `claude` with arguments and resolves with its output; rejects when it cannot run. */
export type ClaudeCodeRunner = (args: ReadonlyArray<string>) => Promise<{ stdout: string; exitCode: number }>;

export function systemClaudeCodeRunner(executable = "claude"): ClaudeCodeRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        [...args],
        { env: claudeCodeEnvironment(process.env), timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" },
        (error, stdout) => {
          // `claude auth status` exits 1 when signed out and still prints its JSON.
          if (error && (typeof error.code !== "number" || !stdout)) reject(error);
          else resolve({ stdout, exitCode: typeof error?.code === "number" ? error.code : 0 });
        },
      );
    });
}

/** The first `major.minor.patch` in `claude --version` output. */
export function parseClaudeCodeVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * The Claude Code version the Agent SDK Wisp ships was built with
 * (`claudeCodeVersion` in its package.json): the oldest `claude` Wisp runs.
 */
export async function minimumClaudeCodeVersion(): Promise<string> {
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(await readFile(path.join(path.dirname(entry), "package.json"), "utf8")) as {
    claudeCodeVersion?: unknown;
  };
  if (typeof manifest.claudeCodeVersion !== "string" || !parseClaudeCodeVersion(manifest.claudeCodeVersion)) {
    throw new Error("The Claude Agent SDK does not name the Claude Code version it was built with.");
  }
  return manifest.claudeCodeVersion;
}

/** Checks the `claude` on this server: installed, recent enough, and signed in. */
export async function detectClaudeCode(run: ClaudeCodeRunner, minimumVersion: string): Promise<ClaudeCodeStatus> {
  let version: string | null;
  try {
    const result = await run(["--version"]);
    version = result.exitCode === 0 ? parseClaudeCodeVersion(result.stdout) : null;
  } catch {
    return { state: "missing" };
  }
  if (!version) return { state: "missing" };
  if (compareVersions(version, minimumVersion) < 0) return { state: "outdated", version, minimumVersion };
  let auth: ClaudeCodeAuthStatus;
  try {
    auth = parseClaudeCodeAuthStatus((await run(["auth", "status", "--json"])).stdout);
  } catch {
    auth = { signedIn: false, billing: "none" };
  }
  if (!auth.signedIn) return { state: "signed_out", version };
  return {
    state: "ready",
    version,
    billing: auth.billing === "subscription" ? "subscription" : "api",
    ...(auth.plan ? { plan: auth.plan } : {}),
  };
}
