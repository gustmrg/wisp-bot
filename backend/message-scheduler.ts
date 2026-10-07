import { randomUUID } from "node:crypto";

import type { ScheduledOrigin } from "../shared/conversations.js";
import {
  MAX_SCHEDULED_MESSAGES_PER_WISP,
  type ScheduledMessage,
  type ScheduledMessagesView,
  type ScheduleMessageRequest,
  type UpdateScheduledMessageRequest,
} from "../shared/scheduled-messages.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import { nextOccurrence } from "./message-schedule.js";
import type { StructuredLogger } from "./structured-logger.js";

/**
 * The longest the scheduler sleeps between checks. Timers stop while a laptop
 * sleeps and do not follow clock changes, so it wakes up regularly to compare
 * against the clock instead of trusting one long timer.
 */
const MAX_TIMER_DELAY_MS = 60_000;
/** A time this recent counts as now rather than past, so "send in 0 minutes" and clock skew still work. */
const PAST_TIME_GRACE_MS = 60_000;

export interface MessageSchedulerOptions {
  repository: Pick<ConversationRepository, "listScheduledMessages" | "addScheduledMessage" | "changeScheduledMessage">;
  /** Sends a message on the person's behalf; see `ConversationService.sendMessage`. */
  send: (conversationId: string, text: string, scheduled: ScheduledOrigin) => Promise<void>;
  /** Receives every scheduled message after any change, including sends. */
  onChanged: (view: ScheduledMessagesView) => void;
  logger?: Pick<StructuredLogger, "warn">;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Sends scheduled messages when they are due, whether or not any client is
 * connected. Messages that came due while the backend was stopped are sent
 * as soon as it starts. A message is claimed (advanced or removed) before it
 * is sent, so a crash in between can lose a send but never repeat one.
 */
export class MessageScheduler {
  private readonly repository: MessageSchedulerOptions["repository"];
  private readonly send: MessageSchedulerOptions["send"];
  private readonly onChanged: MessageSchedulerOptions["onChanged"];
  private readonly logger: MessageSchedulerOptions["logger"];
  private readonly now: () => Date;
  private readonly createId: () => string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: MessageSchedulerOptions) {
    this.repository = options.repository;
    this.send = options.send;
    this.onChanged = options.onChanged;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  /** Starts watching the clock; overdue messages are sent right after. */
  start(): void {
    this.arm(0);
  }

  async getView(): Promise<ScheduledMessagesView> {
    return { messages: await this.repository.listScheduledMessages() };
  }

  async schedule(request: ScheduleMessageRequest): Promise<ScheduledMessagesView> {
    const now = this.now();
    const message: ScheduledMessage = {
      id: this.createId(),
      conversationId: request.conversationId,
      text: request.text,
      schedule: request.schedule,
      timeZone: request.timeZone,
      nextRunAt: firstRun(request, now),
      sentCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.repository.addScheduledMessage(message, MAX_SCHEDULED_MESSAGES_PER_WISP);
    return this.changed();
  }

  async update(request: UpdateScheduledMessageRequest): Promise<ScheduledMessagesView> {
    const now = this.now();
    const previous = await this.repository.changeScheduledMessage(request.scheduledMessageId, (current) => {
      const next = {
        ...current,
        ...(request.text === undefined ? {} : { text: request.text }),
        ...(request.schedule ? { schedule: request.schedule } : {}),
        ...(request.timeZone ? { timeZone: request.timeZone } : {}),
        updatedAt: now.toISOString(),
      };
      const rescheduled = request.schedule !== undefined || request.timeZone !== undefined;
      return rescheduled ? { ...next, nextRunAt: firstRun(next, now) } : next;
    });
    if (!previous) throw notFound();
    return this.changed();
  }

  async cancel(scheduledMessageId: string): Promise<ScheduledMessagesView> {
    const previous = await this.repository.changeScheduledMessage(scheduledMessageId, () => null);
    if (!previous) throw notFound();
    return this.changed();
  }

  /** Sends the next occurrence now instead of at its time; a one-off message is then done. */
  async sendNow(scheduledMessageId: string): Promise<ScheduledMessagesView> {
    const now = this.now();
    const claimed = await this.repository.changeScheduledMessage(scheduledMessageId, (current) =>
      advance(current, now),
    );
    if (!claimed) throw notFound();
    try {
      await this.send(claimed.conversationId, claimed.text, originOf(claimed));
    } finally {
      // Claimed either way, so everyone sees it advanced or gone even when the send failed.
      this.refresh();
    }
    return this.getView();
  }

  /** Publishes the current messages after a change made elsewhere, such as a deleted Wisp. */
  refresh(): void {
    void this.changed().catch((error) => this.warn("scheduled_messages_refresh_failed", error));
  }

  /** Stops sending; waits for a send already in progress to be handed off. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async changed(): Promise<ScheduledMessagesView> {
    const view = await this.getView();
    this.rearm(view.messages);
    this.onChanged(view);
    return view;
  }

  private rearm(messages: ReadonlyArray<ScheduledMessage>): void {
    const soonest = messages[0];
    if (!soonest) {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    this.arm(Date.parse(soonest.nextRunAt) - this.now().getTime());
  }

  private arm(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.running = this.running.then(() => this.runDue());
      },
      Math.min(Math.max(delayMs, 0), MAX_TIMER_DELAY_MS),
    );
  }

  private async runDue(): Promise<void> {
    if (this.disposed) return;
    try {
      const now = this.now();
      let sent = false;
      for (const message of await this.repository.listScheduledMessages()) {
        if (this.disposed) return;
        if (Date.parse(message.nextRunAt) > now.getTime()) break;
        // Checked again in the write queue: the person may have changed it since the list was read.
        const claimed = await this.repository.changeScheduledMessage(message.id, (current) =>
          Date.parse(current.nextRunAt) > now.getTime() ? undefined : advance(current, now),
        );
        if (!claimed) continue;
        sent = true;
        await this.send(claimed.conversationId, claimed.text, originOf(claimed)).catch((error) =>
          this.warn("scheduled_message_send_failed", error, claimed),
        );
      }
      if (sent) await this.changed();
      else this.rearm(await this.repository.listScheduledMessages());
    } catch (error) {
      this.warn("scheduled_messages_run_failed", error);
      this.arm(MAX_TIMER_DELAY_MS);
    }
  }

  private warn(event: string, error: unknown, message?: ScheduledMessage): void {
    this.logger?.warn(event, {
      code: sanitizeBackendError(error).code,
      ...(message ? { conversationId: message.conversationId, scheduledMessageId: message.id } : {}),
    });
  }
}

/** The message after one send at `now`: its next occurrence, or null when it is done. */
function advance(message: ScheduledMessage, now: Date): ScheduledMessage | null {
  // Never before the occurrence just sent, so sending early does not send it twice.
  const after = new Date(Math.max(now.getTime(), Date.parse(message.nextRunAt)));
  const next = nextOccurrence(message.schedule, message.timeZone, after);
  if (!next) return null;
  return {
    ...message,
    nextRunAt: next.toISOString(),
    sentCount: message.sentCount + 1,
    lastSentAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function firstRun(message: Pick<ScheduledMessage, "schedule" | "timeZone">, now: Date): string {
  const first = nextOccurrence(message.schedule, message.timeZone, new Date(now.getTime() - PAST_TIME_GRACE_MS));
  if (!first) throw new WispBackendError("invalid_request", "Choose a time in the future.");
  return first.toISOString();
}

function originOf(message: ScheduledMessage): ScheduledOrigin {
  return { scheduledMessageId: message.id, scheduledAt: message.createdAt, timeZone: message.timeZone };
}

function notFound(): WispBackendError {
  return new WispBackendError("not_found", "The scheduled message was not found.");
}
