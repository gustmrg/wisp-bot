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
  private latest:
    | {
        status: ClaudeCodeStatus;
        executable: string | undefined;
        checkedAt: number;
        /** The last check could not run `claude`, so `status` is from an earlier one. */
        unconfirmed?: true;
      }
    | undefined;
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
    const confirmedReady = this.latest?.status.state === "ready" && !this.latest.unconfirmed;
    const ttl = confirmedReady ? READY_TTL_MS : NOT_READY_TTL_MS;
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

  /**
   * A `claude` that is there but does not answer, as on a busy or slow server,
   * says nothing about its install or sign-in. A ready status then stands, and
   * the next check comes soon: taking it for missing or signed out would leave
   * every Claude Code Wisp without a model until its model is applied again.
   */
  private async check(): Promise<ClaudeCodeStatus> {
    const executable = await this.find();
    if (!executable) return this.remember({ state: "missing" }, executable);
    const run = this.runner(executable);
    let unanswered = false;
    const status = await detectClaudeCode(
      async (args) => {
        try {
          return await run(args);
        } catch (error) {
          unanswered = true;
          throw error;
        }
      },
      await this.minimumVersion(),
    );
    const previous = this.latest;
    if (unanswered && previous?.status.state === "ready" && previous.executable === executable) {
      this.latest = { ...previous, checkedAt: this.now(), unconfirmed: true };
      return previous.status;
    }
    return this.remember(status, executable);
  }

  private remember(status: ClaudeCodeStatus, executable: string | undefined): ClaudeCodeStatus {
    this.latest = { status, executable, checkedAt: this.now() };
    return status;
  }
}
