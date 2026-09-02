import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import { loadPreferences, savePreferences } from "@/features/persistence/preference-storage";
import {
  LEGACY_CONVERSATIONS_STORAGE_KEY,
  MAX_PREFERENCES_BLOB_BYTES,
  PREFERENCES_STORAGE_KEY,
} from "@/features/persistence/storage-policy";

describe("preference storage", () => {
  it("normalizes partially valid saved preferences", () => {
    const storage = {
      getItem: vi.fn((key: string) =>
        key === PREFERENCES_STORAGE_KEY
          ? JSON.stringify({ theme: "dark", launchAtLogin: "yes", notificationSounds: false })
          : null,
      ),
    };

    expect(loadPreferences(storage)).toEqual({
      ok: true,
      value: { ...DEFAULT_PREFERENCES, theme: "dark", notificationSounds: false },
    });
  });

  it("falls back safely for malformed or oversized data", () => {
    expect(loadPreferences({ getItem: () => "{" })).toMatchObject({ ok: false, value: DEFAULT_PREFERENCES });
    expect(loadPreferences({ getItem: () => "x".repeat(MAX_PREFERENCES_BLOB_BYTES + 1) })).toMatchObject({
      ok: false,
      value: DEFAULT_PREFERENCES,
    });
  });

  it("reads preferences from the legacy blob without deleting it", () => {
    const storage = {
      getItem: (key: string) =>
        key === LEGACY_CONVERSATIONS_STORAGE_KEY ? JSON.stringify({ preferences: { theme: "light" } }) : null,
    };
    expect(loadPreferences(storage)).toMatchObject({ ok: true, value: { theme: "light" } });
  });

  it("reports quota failures instead of claiming success", () => {
    const storage = {
      setItem: vi.fn(() => {
        throw new DOMException("full", "QuotaExceededError");
      }),
    };
    expect(savePreferences(storage, DEFAULT_PREFERENCES)).toEqual({
      ok: false,
      error: "Preferences could not be saved on this device.",
      value: undefined,
    });
  });
});
