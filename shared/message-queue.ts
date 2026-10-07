import type { ChatId, ScheduledOrigin } from "./conversations.js";

/** Messages a single Wisp may have waiting at once. */
export const MAX_QUEUED_MESSAGES_PER_WISP = 8;

/**
 * A message waiting for its Wisp to be free. It joins the transcript only
 * when the Wisp takes it, so the transcript is always in the order the Wisp
 * read it.
 */
export interface QueuedMessage {
  /** Also the ID of the transcript message and of the request it becomes. */
  id: string;
  conversationId: ChatId;
  text: string;
  /** When it was queued (ISO 8601). */
  createdAt: string;
  /** Set when a scheduled message queued it. */
  scheduled?: ScheduledOrigin;
}

export interface MessageQueueView {
  /** Every waiting message, oldest first; each Wisp takes its own in this order. */
  messages: ReadonlyArray<QueuedMessage>;
}

export interface QueueMessageRequest {
  conversationId: ChatId;
  text: string;
}

export interface UpdateQueuedMessageRequest {
  queuedMessageId: string;
  text: string;
}

export interface QueuedMessageRequest {
  queuedMessageId: string;
}
