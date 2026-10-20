import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import {
  detectClaudeCode,
  minimumClaudeCodeVersion,
  systemClaudeCodeRunner,
  type ClaudeCodeRunner,
  type ClaudeCodeStatus,
} from "./claude-code-cli.js";
import { claudeCodeUnavailableMessage, type ClaudeCodePlanUsageView } from "../../shared/claude-code.js";
import type { ClaudeCodePlanUsage } from "./claude-code-events.js";

/**
 * How long a status is trusted before the next check runs it again: a ready
 * one for a minute, and one the person is fixing (signing in, updating) only
 * for a few seconds, so settings see the fix soon.
 */
const READY_TTL_MS = 60_000;
const NOT_READY_TTL_MS = 5_000;

export { claudeCodeUnavailableMessage };

/** The first `claude` on PATH, as an absolute path, or undefined. */
export async function findClaudeCode(searchPath = process.env.PATH ?? ""): Promise<string | undefined> {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export interface ClaudeCodeStatusServiceOptions {
  find?: () => Promise<string | undefined>;
  runner?: (executable: string) => ClaudeCodeRunner;
  minimumVersion?: () => Promise<string>;
  now?: () => number;
}

/**
 * Whether this server can run Claude Code Wisps. Checking runs `claude`, so
 * the result is kept for a minute; the model service and session factory read
 * the latest one synchronously.
 */
export class ClaudeCodeStatusService {
  private readonly find: () => Promise<string | undefined>;
  private readonly runner: (executable: string) => ClaudeCodeRunner;
  private readonly minimumVersion: () => Promise<string>;
  private readonly now: () => number;
  private latest: { status: ClaudeCodeStatus; executable: string | undefined; checkedAt: number } | undefined;
  private pending: Promise<ClaudeCodeStatus> | undefined;
  private planUsage: ClaudeCodePlanUsageView | undefined;

  constructor(options: ClaudeCodeStatusServiceOptions = {}) {
    this.find = options.find ?? (() => findClaudeCode());
    this.runner = options.runner ?? systemClaudeCodeRunner;
    this.minimumVersion = options.minimumVersion ?? minimumClaudeCodeVersion;
    this.now = options.now ?? Date.now;
  }

  /** The latest status, or undefined before the first check. */
  current(): ClaudeCodeStatus | undefined {
    return this.latest && this.withPlanUsage(this.latest.status);
  }

  /** Keeps the plan's usage the latest turn reported, shown with a ready status. */
  recordPlanUsage(usage: ClaudeCodePlanUsage | undefined): void {
    if (!usage) return;
    this.planUsage = {
      limited: usage.status === "rejected",
      windows: (["five_hour", "seven_day"] as const).flatMap((window) => {
        const value = usage.windows[window];
        return value
          ? [{ window, utilization: value.utilization, resetsAt: new Date(value.resetsAt * 1000).toISOString() }]
          : [];
      }),
    };
  }

  /** The `claude` the latest check found. */
  executable(): string | undefined {
    return this.latest?.executable;
  }

  /** Checks again unless the latest result is recent; `force` always checks. */
  async refresh(force = false): Promise<ClaudeCodeStatus> {
    const ttl = this.latest?.status.state === "ready" ? READY_TTL_MS : NOT_READY_TTL_MS;
    if (!force && this.latest && this.now() - this.latest.checkedAt < ttl)
      return this.withPlanUsage(this.latest.status);
    this.pending ??= this.check().finally(() => {
      this.pending = undefined;
    });
    return this.withPlanUsage(await this.pending);
  }

  private withPlanUsage(status: ClaudeCodeStatus): ClaudeCodeStatus {
    return status.state === "ready" && this.planUsage ? { ...status, planUsage: this.planUsage } : status;
  }

  private async check(): Promise<ClaudeCodeStatus> {
    const executable = await this.find();
    const status: ClaudeCodeStatus = executable
      ? await detectClaudeCode(this.runner(executable), await this.minimumVersion())
      : { state: "missing" };
    this.latest = { status, executable, checkedAt: this.now() };
    return status;
  }
}
