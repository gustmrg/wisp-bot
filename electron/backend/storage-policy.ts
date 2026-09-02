// Temporary limits for the local desktop store. Revisit these before supporting
// unbounded transcripts or media; those require a database/blob-store design.
export const CONVERSATION_STORAGE_POLICY = {
  maxBlobBytes: 32 * 1024 * 1024,
  maxConversations: 1_000,
  maxMessagesPerConversation: 10_000,
  maxTextLength: 100_000,
  maxAvatarDataUrlLength: 6_000_000,
} as const;

export const WEBP_DATA_URL_PREFIX = "data:image/webp;base64,";
