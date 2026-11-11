// Limits on what one request may carry into the conversation store. Stored
// history itself has no limit: transcripts live in SQLite and are read a page
// at a time (ADR 006).
export const CONVERSATION_STORAGE_POLICY = {
  /** The messages a new conversation may start with. */
  maxMessagesPerRequest: 10_000,
  maxTextLength: 100_000,
} as const;
