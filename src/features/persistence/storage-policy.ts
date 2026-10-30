// Limits for small renderer-owned preferences. Conversation history belongs to
// the backend.
export const PREFERENCES_STORAGE_KEY = "wisp-bot-preferences-v1";
/** Set when the person turned off the "Connected to" notice for servers on this device. */
export const CONNECTION_NOTICES_OFF_STORAGE_KEY = "wisp-bot-connection-notices-off";
export const PREFERENCES_SAVE_DELAY_MS = 300;
export const MAX_PREFERENCES_BLOB_BYTES = 64_000;

export type PersistenceStatus = "idle" | "saving" | "saved" | "error";
