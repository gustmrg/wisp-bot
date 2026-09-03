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
      autoReviewRules: [{ id: "rule-1", action: "Read files", behavior: "ask", scope: "workspace" }],
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
      autoReviewRules: [{ id: "valid", action: "Run tests", behavior: "ask", scope: "workspace" }],
    });
  });

  it("never migrates a legacy free-text allow rule into automatic authorization", () => {
    const migrated = normalizePreferences({
      autoReviewRules: [{ id: "legacy", action: "Whatever the model asks", behavior: "allow" }],
    });
    expect(migrated.autoReviewRules).toEqual([
      { id: "legacy", action: "Whatever the model asks", behavior: "ask", scope: "workspace" },
    ]);
  });
});
