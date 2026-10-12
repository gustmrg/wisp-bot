import type { ScheduledOrigin } from "../shared/conversations.js";
import type { MessageSchedule, ScheduledMessage } from "../shared/scheduled-messages.js";
import { isoTime, normalizeSchedule } from "../shared/schedule.js";
import { isTimeZone } from "../shared/time-zone.js";

/** A valid schedule for a scheduled message (only one-off sends today), or undefined. */
export function normalizeMessageSchedule(value: unknown): MessageSchedule | undefined {
  const schedule = normalizeSchedule(value);
  return schedule?.kind === "once" ? schedule : undefined;
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

/**
 * What the model reads before a scheduled message, so it knows the person
 * wrote it earlier and may not be there to answer questions. Never shown in
 * the transcript.
 */
export function scheduledMessageNote(origin: ScheduledOrigin, sentAt: Date): string {
  const timeZone = isTimeZone(origin.timeZone) ? origin.timeZone : "UTC";
  const format = (time: Date) => formatNoteTime(time, timeZone);
  return `[Sent automatically: the user wrote this message on ${format(new Date(origin.scheduledAt))} and scheduled it; it was sent on ${format(sentAt)} (${timeZone}). They may not be present, so do what you can without waiting for their reply.]`;
}

/**
 * What the model reads before a message the person sends, so it knows their
 * local date and time. Never shown in the transcript.
 */
export function currentTimeNote(sentAt: Date, timeZone: string): string {
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  return `[Sent on ${formatNoteTime(sentAt, zone)} (${zone})]`;
}

function formatNoteTime(time: Date, timeZone: string): string {
  return time.toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
