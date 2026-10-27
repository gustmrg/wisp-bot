import type { SessionReportUsage } from "../shared/contracts.js";
import type { Job, JobLastRun, JobPauseReason, JobRetry, JobRun, JobRunStatus, JobRunTrigger } from "../shared/jobs.js";
import { isoTime, normalizeSchedule } from "../shared/schedule.js";
import { isTimeZone } from "../shared/time-zone.js";

const RUN_STATUSES: ReadonlyArray<JobRunStatus> = ["delivered", "silent", "failed", "skipped"];
const RUN_TRIGGERS: ReadonlyArray<JobRunTrigger> = ["on_time", "catch_up", "retry", "manual"];
const PAUSE_REASONS: ReadonlyArray<JobPauseReason> = ["person", "failures"];

type Fields = Record<string, unknown>;

function asFields(value: unknown): Fields | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : undefined;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isId);
}

/** An optional field: absent stays absent, present must be valid. */
function optional<T>(value: unknown, parse: (value: unknown) => T | undefined): { ok: boolean; value?: T } {
  if (value === undefined) return { ok: true };
  const parsed = parse(value);
  return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(values: ReadonlyArray<T>) {
  return (value: unknown): T | undefined => (values.includes(value as T) ? (value as T) : undefined);
}

function retryOf(value: unknown): JobRetry | undefined {
  const fields = asFields(value);
  const scheduledAt = isoTime(fields?.scheduledAt);
  if (!fields || !scheduledAt || !Number.isSafeInteger(fields.attempt) || (fields.attempt as number) < 1) {
    return undefined;
  }
  return { attempt: fields.attempt as number, scheduledAt };
}

function pauseOf(value: unknown): Job["paused"] {
  const fields = asFields(value);
  const reason = oneOf(PAUSE_REASONS)(fields?.reason);
  const at = isoTime(fields?.at);
  return reason && at ? { reason, at } : undefined;
}

function lastRunOf(value: unknown): JobLastRun | undefined {
  const fields = asFields(value);
  const status = oneOf(RUN_STATUSES)(fields?.status);
  const endedAt = isoTime(fields?.endedAt);
  if (!fields || !isId(fields.runId) || !status || !endedAt) return undefined;
  const errorCode = optional(fields.errorCode, optionalString);
  const deliveryErrorCode = optional(fields.deliveryErrorCode, optionalString);
  if (!errorCode.ok || !deliveryErrorCode.ok) return undefined;
  return {
    runId: fields.runId,
    status,
    endedAt,
    ...(errorCode.value ? { errorCode: errorCode.value } : {}),
    ...(deliveryErrorCode.value ? { deliveryErrorCode: deliveryErrorCode.value } : {}),
  };
}

function usageOf(value: unknown): SessionReportUsage | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
  if (!keys.every((key) => isCount(fields[key]))) return undefined;
  return Object.fromEntries(keys.map((key) => [key, fields[key]])) as unknown as SessionReportUsage;
}

/** A stored job, or undefined when the record is not valid. */
export function normalizeJob(value: unknown): Job | undefined {
  const record = asFields(value);
  if (!record) return undefined;
  const schedule = normalizeSchedule(record.schedule);
  const createdAt = isoTime(record.createdAt);
  const updatedAt = isoTime(record.updatedAt);
  const nextRunAt = optional(record.nextRunAt, isoTime);
  const retry = optional(record.retry, retryOf);
  const paused = optional(record.paused, pauseOf);
  const lastRun = optional(record.lastRun, lastRunOf);
  if (
    !isId(record.id) ||
    !isId(record.conversationId) ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    typeof record.instructions !== "string" ||
    !record.instructions.trim() ||
    !isNames(record.skills) ||
    !isNames(record.tools) ||
    !schedule ||
    !isTimeZone(record.timeZone) ||
    typeof record.state !== "string" ||
    !isCount(record.runCount) ||
    !isCount(record.consecutiveFailures) ||
    !createdAt ||
    !updatedAt ||
    !nextRunAt.ok ||
    !retry.ok ||
    !paused.ok ||
    !lastRun.ok
  ) {
    return undefined;
  }
  return {
    id: record.id,
    conversationId: record.conversationId,
    title: record.title,
    instructions: record.instructions,
    skills: [...record.skills],
    tools: [...record.tools],
    schedule,
    timeZone: record.timeZone,
    ...(nextRunAt.value ? { nextRunAt: nextRunAt.value } : {}),
    ...(retry.value ? { retry: retry.value } : {}),
    ...(paused.value ? { paused: paused.value } : {}),
    state: record.state,
    runCount: record.runCount,
    consecutiveFailures: record.consecutiveFailures,
    ...(lastRun.value ? { lastRun: lastRun.value } : {}),
    createdAt,
    updatedAt,
  };
}

/** A stored job run, or undefined when the record is not valid. */
export function normalizeJobRun(value: unknown): JobRun | undefined {
  const record = asFields(value);
  if (!record) return undefined;
  const trigger = oneOf(RUN_TRIGGERS)(record.trigger);
  const scheduledAt = isoTime(record.scheduledAt);
  const startedAt = isoTime(record.startedAt);
  const endedAt = optional(record.endedAt, isoTime);
  const status = optional(record.status, oneOf(RUN_STATUSES));
  const errorCode = optional(record.errorCode, optionalString);
  const deliveryErrorCode = optional(record.deliveryErrorCode, optionalString);
  const skipReason = optional(record.skipReason, optionalString);
  const notRetriedAfter = optional(record.notRetriedAfter, (value) => (isNames(value) ? value : undefined));
  const usage = optional(record.usage, usageOf);
  const messageId = optional(record.messageId, optionalString);
  const sessionFile = optional(record.sessionFile, optionalString);
  if (
    !isId(record.id) ||
    !isId(record.jobId) ||
    !isId(record.conversationId) ||
    !trigger ||
    !scheduledAt ||
    !startedAt ||
    ![endedAt, status, errorCode, deliveryErrorCode, skipReason, notRetriedAfter, usage, messageId, sessionFile].every(
      ({ ok }) => ok,
    )
  ) {
    return undefined;
  }
  return {
    id: record.id,
    jobId: record.jobId,
    conversationId: record.conversationId,
    trigger,
    scheduledAt,
    startedAt,
    ...(endedAt.value ? { endedAt: endedAt.value } : {}),
    ...(status.value ? { status: status.value } : {}),
    ...(errorCode.value ? { errorCode: errorCode.value } : {}),
    ...(deliveryErrorCode.value ? { deliveryErrorCode: deliveryErrorCode.value } : {}),
    ...(skipReason.value ? { skipReason: skipReason.value } : {}),
    ...(notRetriedAfter.value?.length ? { notRetriedAfter: notRetriedAfter.value } : {}),
    ...(usage.value ? { usage: usage.value } : {}),
    ...(messageId.value ? { messageId: messageId.value } : {}),
    ...(sessionFile.value ? { sessionFile: sessionFile.value } : {}),
  };
}
