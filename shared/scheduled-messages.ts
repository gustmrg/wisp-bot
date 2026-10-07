import type { ChatId } from "./conversations.js";

/** Scheduled messages a single Wisp may hold at once. */
export const MAX_SCHEDULED_MESSAGES_PER_WISP = 50;

/**
 * When a scheduled message is sent. Only one-off sends exist today; a
 * recurring kind (a rule evaluated in the message's time zone) joins this
 * union and `nextOccurrence` in the backend without changing stored records.
 */
export type MessageSchedule = { kind: "once"; at: string };

/** A message the backend sends to a Wisp on the person's behalf, as if typed then. */
export interface ScheduledMessage {
  id: string;
  conversationId: ChatId;
  text: string;
  schedule: MessageSchedule;
  /** IANA time zone the person scheduled in, so wall-clock schedules follow it even on a server elsewhere. */
  timeZone: string;
  /** When it is sent next (ISO 8601, UTC). A schedule that will never send again is removed. */
  nextRunAt: string;
  /** How many times it has been sent; one-off messages are removed after their only send. */
  sentCount: number;
  lastSentAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledMessagesView {
  /** Every scheduled message, soonest first. */
  messages: ReadonlyArray<ScheduledMessage>;
}

export interface ScheduleMessageRequest {
  conversationId: ChatId;
  text: string;
  schedule: MessageSchedule;
  timeZone: string;
}

/** Changes a scheduled message; its next send is recomputed when the schedule or time zone changes. */
export interface UpdateScheduledMessageRequest {
  scheduledMessageId: string;
  text?: string;
  schedule?: MessageSchedule;
  timeZone?: string;
}

export interface ScheduledMessageRequest {
  scheduledMessageId: string;
}
