// Temporary limits for small renderer-owned preferences and one-time legacy
// migration. Conversation history belongs to the Electron repository.
export const PREFERENCES_STORAGE_KEY = "wisp-bot-preferences-v1";
export const LEGACY_CONVERSATIONS_STORAGE_KEY = "wisp-bot-ui-v3";
export const PREFERENCES_SAVE_DELAY_MS = 300;
export const MAX_PREFERENCES_BLOB_BYTES = 64_000;
export const MAX_LEGACY_BLOB_BYTES = 16 * 1024 * 1024;

export type PersistenceStatus = "idle" | "saving" | "saved" | "error";
