import { randomUUID } from "node:crypto";

import type { ScheduledOrigin } from "../shared/conversations.js";
import { MAX_QUEUED_MESSAGES_PER_WISP, type MessageQueueView, type QueuedMessage } from "../shared/message-queue.js";
import { sanitizeBackendError, WispBackendError } from "./backend-error.js";
import type { ConversationRepository } from "./conversation-repository.js";
import { normalizeScheduledOrigin } from "./conversation-normalizer.js";
import type { StructuredLogger } from "./structured-logger.js";

export interface MessageQueueOptions {
  repository: Pick<ConversationRepository, "listQueuedMessages" | "addQueuedMessage" | "changeQueuedMessage">;
  /** Whether the Wisp can take a message now; see `AgentRegistry.isAvailable`. */
  isAvailable: (conversationId: string) => boolean;
  /**
   * Hands the Wisp its oldest waiting message; see
   * `ConversationService.deliverNextQueued`. Calls `onTaken` once the message
   * has left the queue, and resolves after the Wisp has answered it.
   */
  deliverNext: (conversationId: string, onTaken: () => void) => Promise<QueuedMessage | undefined>;
  /**
   * Hands a message to the Wisp's running turn as a follow-up; see
   * `AgentRegistry.steer`. Resolves false when no turn can take it.
   */
  steer?: (message: QueuedMessage) => Promise<boolean>;
  /** Takes back the follow-ups handed to the Wisp's running turn that it has not read; see `AgentRegistry`. */
  withdrawFollowUps?: (conversationId: string) => string[];
  /** Receives every queued message after any change, including a message being taken. */
  onChanged: (view: MessageQueueView) => void;
  logger?: Pick<StructuredLogger, "warn">;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Messages waiting for their Wisp. A Wisp takes the next one only once it is
 * free, so a message joins the transcript right before the reply to it. The
 * queue is stored, so messages still waiting when Wisp stops are sent after
 * it starts again.
 */
export class MessageQueue {
  private readonly repository: MessageQueueOptions["repository"];
  private readonly isAvailable: MessageQueueOptions["isAvailable"];
  private readonly deliverNext: MessageQueueOptions["deliverNext"];
  private readonly steer: NonNullable<MessageQueueOptions["steer"]>;
  private readonly withdrawFollowUps: NonNullable<MessageQueueOptions["withdrawFollowUps"]>;
  private readonly onChanged: MessageQueueOptions["onChanged"];
  private readonly logger: MessageQueueOptions["logger"];
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Wisps answering a message from the queue; each takes one at a time. */
  private readonly delivering = new Set<string>();
  /** Messages handed to their Wisp's running turn and not read yet. */
  private readonly followUps = new Set<string>();
  /** Wisps whose waiting messages are being handed to their running turn; one pass at a time. */
  private readonly steering = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(options: MessageQueueOptions) {
    this.repository = options.repository;
    this.isAvailable = options.isAvailable;
    this.deliverNext = options.deliverNext;
    this.steer = options.steer ?? (async () => false);
    this.withdrawFollowUps = options.withdrawFollowUps ?? (() => []);
    this.onChanged = options.onChanged;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  /** Sends what was waiting when Wisp last stopped, to every Wisp free to take it. */
  async start(): Promise<void> {
    const waiting = await this.repository.listQueuedMessages();
    for (const conversationId of new Set(waiting.map(({ conversationId }) => conversationId))) {
      this.pump(conversationId);
    }
  }

  async getView(): Promise<MessageQueueView> {
    const messages = await this.repository.listQueuedMessages();
    return {
      messages: messages.map((message) => (this.followUps.has(message.id) ? { ...message, followUp: true } : message)),
    };
  }

  /**
   * Puts a message in line for a Wisp; a free Wisp takes it right away.
   * Messages the person queues are limited per Wisp; scheduled ones are not,
   * so a busy Wisp never loses one.
   */
  async enqueue(
    conversationId: string,
    text: string,
    options: { scheduled?: ScheduledOrigin } = {},
  ): Promise<MessageQueueView> {
    const message: QueuedMessage = {
      id: this.createId(),
      conversationId,
      text,
      createdAt: this.now().toISOString(),
      ...(options.scheduled ? { scheduled: options.scheduled } : {}),
    };
    await this.repository.addQueuedMessage(message, options.scheduled ? undefined : MAX_QUEUED_MESSAGES_PER_WISP);
    this.pump(conversationId);
    await this.offerFollowUps(conversationId);
    return this.changed();
  }

  async update(queuedMessageId: string, text: string): Promise<MessageQueueView> {
    return this.change(queuedMessageId, (current) => ({ ...current, text }));
  }

  async cancel(queuedMessageId: string): Promise<MessageQueueView> {
    return this.change(queuedMessageId, () => null);
  }

  /**
   * Hands the Wisp's waiting messages to its running turn, oldest first, so
   * it reads them before its next step. Scheduled messages are tasks of their
   * own and wait for the turn to end, and so does everything after one.
   */
  async offerFollowUps(conversationId: string): Promise<void> {
    const previous = this.steering.get(conversationId) ?? Promise.resolve();
    const pass = previous.then(async () => {
      if (this.disposed || this.isAvailable(conversationId)) return;
      const waiting = (await this.repository.listQueuedMessages()).filter(
        (message) => message.conversationId === conversationId,
      );
      let offered = false;
      for (const message of waiting) {
        if (this.followUps.has(message.id)) continue;
        if (message.scheduled) break;
        this.followUps.add(message.id);
        let taken = false;
        try {
          taken = await this.steer(message);
        } catch (error) {
          this.logger?.warn("follow_up_steer_failed", { conversationId, code: sanitizeBackendError(error).code });
        }
        if (!taken) {
          this.followUps.delete(message.id);
          break;
        }
        offered = true;
      }
      if (offered) await this.changed();
    });
    const settled = pass.catch((error) =>
      this.logger?.warn("follow_up_offer_failed", { conversationId, code: sanitizeBackendError(error).code }),
    );
    this.steering.set(conversationId, settled);
    await settled;
    if (this.steering.get(conversationId) === settled) this.steering.delete(conversationId);
  }

  /** Called once the running turn read a follow-up and it left the queue for the transcript. */
  followUpTaken(queuedMessageId: string): void {
    this.followUps.delete(queuedMessageId);
    this.refresh();
  }

  /**
   * Removes follow-ups a stopped turn never read, so the person can send them
   * again, and answers them oldest first. Those already gone are left out.
   */
  async returnFollowUps(queuedMessageIds: ReadonlyArray<string>): Promise<QueuedMessage[]> {
    const returned: QueuedMessage[] = [];
    for (const id of queuedMessageIds) {
      this.followUps.delete(id);
      const message = await this.repository.changeQueuedMessage(id, () => null);
      if (message) returned.push(message);
    }
    if (queuedMessageIds.length) await this.changed();
    return returned;
  }

  /**
   * Changes or removes a waiting message. One the running turn holds is taken
   * back from it first, with the ones after it, which are handed over again
   * in order once the change is made.
   */
  private async change(
    queuedMessageId: string,
    change: (current: QueuedMessage) => QueuedMessage | null,
  ): Promise<MessageQueueView> {
    let conversationId: string | undefined;
    if (this.followUps.has(queuedMessageId)) {
      conversationId = (await this.repository.listQueuedMessages()).find(
        ({ id }) => id === queuedMessageId,
      )?.conversationId;
      if (conversationId) {
        await this.steering.get(conversationId);
        for (const id of this.withdrawFollowUps(conversationId)) this.followUps.delete(id);
      }
    }
    const previous = await this.repository.changeQueuedMessage(queuedMessageId, change);
    if (conversationId) await this.offerFollowUps(conversationId);
    if (!previous) throw alreadySent();
    return this.changed();
  }

  /** Hands the Wisp its next message if it is free; call whenever it may have become free. */
  pump(conversationId: string): void {
    if (this.disposed || this.delivering.has(conversationId) || !this.isAvailable(conversationId)) return;
    // The turn that held follow-ups has ended and gave back those it did not read; they are sent like the rest.
    void this.forgetFollowUps(conversationId);
    this.delivering.add(conversationId);
    void (async () => {
      let delivered = false;
      try {
        delivered = Boolean(await this.deliverNext(conversationId, () => this.refresh()));
      } catch (error) {
        this.logger?.warn("queued_message_delivery_failed", {
          conversationId,
          code: sanitizeBackendError(error).code,
        });
      } finally {
        this.delivering.delete(conversationId);
      }
      // The Wisp is free again only after its reply, so look for the next message then.
      if (delivered) this.pump(conversationId);
    })();
  }

  private async forgetFollowUps(conversationId: string): Promise<void> {
    if (!this.followUps.size) return;
    const waiting = await this.repository.listQueuedMessages();
    let forgot = false;
    for (const message of waiting) {
      if (message.conversationId === conversationId && this.followUps.delete(message.id)) forgot = true;
    }
    if (forgot) this.refresh();
  }

  /** Publishes the current queue after a change made elsewhere, such as a deleted Wisp. */
  refresh(): void {
    void this.changed().catch((error) =>
      this.logger?.warn("message_queue_refresh_failed", { code: sanitizeBackendError(error).code }),
    );
  }

  /** Stops handing out messages; those still waiting stay stored for the next start. */
  dispose(): void {
    this.disposed = true;
  }

  private async changed(): Promise<MessageQueueView> {
    const view = await this.getView();
    this.onChanged(view);
    return view;
  }
}

/** A stored queued message, or undefined when the record is not valid. */
export function normalizeQueuedMessage(value: unknown): QueuedMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.conversationId !== "string" ||
    !record.conversationId ||
    typeof record.text !== "string" ||
    !record.text.trim() ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    return undefined;
  }
  let scheduled: ScheduledOrigin | undefined;
  try {
    scheduled = record.scheduled === undefined ? undefined : normalizeScheduledOrigin(record.scheduled);
  } catch {
    return undefined;
  }
  return {
    id: record.id,
    conversationId: record.conversationId,
    text: record.text,
    createdAt: record.createdAt,
    ...(scheduled ? { scheduled } : {}),
  };
}

function alreadySent(): WispBackendError {
  return new WispBackendError("not_found", "The Wisp already took this message.");
}
