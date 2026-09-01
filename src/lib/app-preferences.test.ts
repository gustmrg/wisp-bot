import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, normalizePreferences } from "@/lib/app-preferences";

describe("normalizePreferences", () => {
  it("returns defaults when no saved preferences exist", () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it("preserves valid preferences", () => {
    expect(
      normalizePreferences({
        theme: "dark",
        launchAtLogin: true,
        notificationSounds: false,
        microphone: "studio-mic",
        hardwareAcceleration: false,
        timezone: "UTC",
        autoReview: false,
        autoReviewRules: [{ id: "rule-1", action: "Read files", behavior: "ask" }],
      }),
    ).toEqual({
      theme: "dark",
      launchAtLogin: true,
      notificationSounds: false,
      microphone: "studio-mic",
      hardwareAcceleration: false,
      timezone: "UTC",
      autoReview: false,
      autoReviewRules: [{ id: "rule-1", action: "Read files", behavior: "ask" }],
    });
  });

  it("falls back for invalid values and removes malformed rules", () => {
    expect(
      normalizePreferences({
        theme: "sepia" as never,
        launchAtLogin: "yes" as never,
        notificationSounds: 1 as never,
        microphone: "",
        hardwareAcceleration: null as never,
        timezone: "Not/A_Timezone",
        autoReview: "enabled" as never,
        autoReviewRules: [
          { id: "valid", action: "Run tests", behavior: "allow" },
          { id: "empty", action: " ", behavior: "ask" },
          { id: "invalid", action: "Deploy", behavior: "sometimes" as never },
        ],
      }),
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      autoReviewRules: [{ id: "valid", action: "Run tests", behavior: "allow" }],
    });
  });
});
