// Limits for the local conversation store. Transcripts live in SQLite, so no
// whole-store size cap applies; each conversation keeps its newest messages.
export const CONVERSATION_STORAGE_POLICY = {
  /** Upper bound for reading the legacy single-file JSON store during migration. */
  maxLegacyStateBytes: 32 * 1024 * 1024,
  maxConversations: 1_000,
  maxMessagesPerConversation: 10_000,
  maxTextLength: 100_000,
  maxAvatarDataUrlLength: 6_000_000,
} as const;

export const WEBP_DATA_URL_PREFIX = "data:image/webp;base64,";
