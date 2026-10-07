import type { ScheduledOrigin } from "../shared/conversations.js";
import type { MessageSchedule, ScheduledMessage } from "../shared/scheduled-messages.js";

/** Whether `value` names a time zone this runtime knows, such as "America/Sao_Paulo". */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A valid schedule with its times in canonical UTC form, or undefined. */
export function normalizeMessageSchedule(value: unknown): MessageSchedule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === "once") {
    const at = isoTime(schedule.at);
    return at ? { kind: "once", at } : undefined;
  }
  return undefined;
}

/**
 * The first time the schedule sends strictly after `after`, or null when it
 * never sends again. Recurring kinds evaluate their rule in `timeZone`.
 */
export function nextOccurrence(schedule: MessageSchedule, _timeZone: string, after: Date): Date | null {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : null;
    }
  }
}

/** A stored scheduled message, or undefined when the record is not valid. */
export function normalizeScheduledMessage(value: unknown): ScheduledMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const schedule = normalizeMessageSchedule(record.schedule);
  const nextRunAt = isoTime(record.nextRunAt);
  const createdAt = isoTime(record.createdAt);
  const updatedAt = isoTime(record.updatedAt);
  const lastSentAt = record.lastSentAt === undefined ? undefined : isoTime(record.lastSentAt);
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.conversationId !== "string" ||
    !record.conversationId ||
    typeof record.text !== "string" ||
    !record.text.trim() ||
    !schedule ||
    !isTimeZone(record.timeZone) ||
    !nextRunAt ||
    !Number.isSafeInteger(record.sentCount) ||
    (record.sentCount as number) < 0 ||
    !createdAt ||
    !updatedAt ||
    (record.lastSentAt !== undefined && !lastSentAt)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    conversationId: record.conversationId,
    text: record.text,
    schedule,
    timeZone: record.timeZone,
    nextRunAt,
    sentCount: record.sentCount as number,
    ...(lastSentAt ? { lastSentAt } : {}),
    createdAt,
    updatedAt,
  };
}

const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 time with an explicit offset, as UTC; local times without an offset are ambiguous and refused. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * What the model reads before a scheduled message, so it knows the person
 * wrote it earlier and may not be there to answer questions. Never shown in
 * the transcript.
 */
export function scheduledMessageNote(origin: ScheduledOrigin, sentAt: Date): string {
  const timeZone = isTimeZone(origin.timeZone) ? origin.timeZone : "UTC";
  const format = (time: Date) =>
    time.toLocaleString("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  return `[Sent automatically: the user wrote this message on ${format(new Date(origin.scheduledAt))} and scheduled it; it was sent on ${format(sentAt)} (${timeZone}). They may not be present, so do what you can without waiting for their reply.]`;
}
