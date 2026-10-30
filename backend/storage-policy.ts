// Limits for the local conversation store. Transcripts live in SQLite, so no
// whole-store size cap applies; each conversation keeps its newest messages.
export const CONVERSATION_STORAGE_POLICY = {
  maxMessagesPerConversation: 10_000,
  maxTextLength: 100_000,
} as const;
