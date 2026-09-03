import { DEFAULT_PREFERENCES, normalizePreferences, type AppPreferences } from "@/lib/app-preferences";
import {
  LEGACY_CONVERSATIONS_STORAGE_KEY,
  MAX_LEGACY_BLOB_BYTES,
  MAX_PREFERENCES_BLOB_BYTES,
  PREFERENCES_STORAGE_KEY,
} from "@/features/persistence/storage-policy";

export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: string; value: T };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parsedJson(raw: string, maximumBytes: number): unknown {
  if (utf8Bytes(raw) > maximumBytes) throw new Error("Saved data exceeds the local storage limit.");
  return JSON.parse(raw) as unknown;
}

function legacyPreferences(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, "preferences") ? Reflect.get(value, "preferences") : undefined;
}

export function loadPreferences(storage: Pick<Storage, "getItem">): StorageResult<AppPreferences> {
  try {
    const current = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (current !== null)
      return { ok: true, value: normalizePreferences(parsedJson(current, MAX_PREFERENCES_BLOB_BYTES)) };
    const legacy = storage.getItem(LEGACY_CONVERSATIONS_STORAGE_KEY);
    if (legacy !== null) {
      return {
        ok: true,
        value: normalizePreferences(legacyPreferences(parsedJson(legacy, MAX_LEGACY_BLOB_BYTES))),
      };
    }
    return { ok: true, value: DEFAULT_PREFERENCES };
  } catch {
    return {
      ok: false,
      error: "Saved preferences could not be read. Defaults are in use.",
      value: DEFAULT_PREFERENCES,
    };
  }
}

export function savePreferences(
  storage: Pick<Storage, "setItem">,
  preferences: AppPreferences,
): StorageResult<undefined> {
  try {
    const serialized = JSON.stringify(preferences);
    if (utf8Bytes(serialized) > MAX_PREFERENCES_BLOB_BYTES) throw new Error("Preferences exceed the storage limit.");
    storage.setItem(PREFERENCES_STORAGE_KEY, serialized);
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "Preferences could not be saved on this device.", value: undefined };
  }
}
