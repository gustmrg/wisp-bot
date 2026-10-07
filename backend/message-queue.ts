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
  private readonly onChanged: MessageQueueOptions["onChanged"];
  private readonly logger: MessageQueueOptions["logger"];
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Wisps answering a message from the queue; each takes one at a time. */
  private readonly delivering = new Set<string>();
  private disposed = false;

  constructor(options: MessageQueueOptions) {
    this.repository = options.repository;
    this.isAvailable = options.isAvailable;
    this.deliverNext = options.deliverNext;
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
    return { messages: await this.repository.listQueuedMessages() };
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
    const view = await this.changed();
    this.pump(conversationId);
    return view;
  }

  async update(queuedMessageId: string, text: string): Promise<MessageQueueView> {
    const previous = await this.repository.changeQueuedMessage(queuedMessageId, (current) => ({ ...current, text }));
    if (!previous) throw alreadySent();
    return this.changed();
  }

  async cancel(queuedMessageId: string): Promise<MessageQueueView> {
    const previous = await this.repository.changeQueuedMessage(queuedMessageId, () => null);
    if (!previous) throw alreadySent();
    return this.changed();
  }

  /** Hands the Wisp its next message if it is free; call whenever it may have become free. */
  pump(conversationId: string): void {
    if (this.disposed || this.delivering.has(conversationId) || !this.isAvailable(conversationId)) return;
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
