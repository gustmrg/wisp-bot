import { systemTimeZone, zonedParts, zonedTime } from "./time-zone.js";

export interface ContextPolicy {
  mode: "idle" | "daily" | "both" | "none";
  idleHours: number;
  minimumTokens: number;
  dailyHour: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  mode: "idle",
  idleHours: 24,
  minimumTokens: 12_000,
  dailyHour: 4,
};

export interface ContextView {
  policy: ContextPolicy;
  memory: string;
  summary: string | null;
  lastRenewedAt: string | null;
  lastActivityAt: string | null;
  tokens: number;
}

export type ContextCommand =
  | { action: "get" }
  | { action: "save"; policy: ContextPolicy; memory: string }
  | { action: "compact" }
  | { action: "new_topic" };

export interface ContextRequest {
  conversationId: string;
  command: ContextCommand;
}

export function isContextPolicy(value: unknown): value is ContextPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as ContextPolicy;
  return (
    Object.keys(policy).every((key) => ["mode", "idleHours", "minimumTokens", "dailyHour"].includes(key)) &&
    ["idle", "daily", "both", "none"].includes(policy.mode) &&
    Number.isInteger(policy.idleHours) &&
    policy.idleHours >= 1 &&
    policy.idleHours <= 720 &&
    Number.isInteger(policy.minimumTokens) &&
    policy.minimumTokens >= 1000 &&
    policy.minimumTokens <= 200000 &&
    Number.isInteger(policy.dailyHour) &&
    policy.dailyHour >= 0 &&
    policy.dailyHour <= 23
  );
}

export function shouldRenewContext(
  policy: ContextPolicy,
  lastActivity: string | null,
  tokens: number,
  now: Date,
  timeZone: string = systemTimeZone(),
): boolean {
  if (!lastActivity || tokens < policy.minimumTokens || policy.mode === "none") return false;
  const last = Date.parse(lastActivity);
  if (!Number.isFinite(last) || last >= now.getTime()) return false;
  const idle = now.getTime() - last >= policy.idleHours * 3600000;
  // The most recent time the clock showed `dailyHour` in the user's time zone.
  const today = zonedParts(now, timeZone);
  let boundary = zonedTime({ ...today, hour: policy.dailyHour, minute: 0 }, timeZone);
  if (boundary > now)
    boundary = zonedTime({ ...today, day: today.day - 1, hour: policy.dailyHour, minute: 0 }, timeZone);
  const daily = last < boundary.getTime();
  return policy.mode === "idle" ? idle : policy.mode === "daily" ? daily : idle || daily;
}
