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
        voiceProvider: "openai",
        voiceModel: "gpt-4o-transcribe",
        voiceLanguage: "pt",
        voiceAutoSend: true,
        shortcuts: { voiceInput: "Ctrl+Shift+KeyM" },
        hardwareAcceleration: false,
        timezone: "UTC",
        autoReview: false,
        autoReviewRules: [{ id: "rule-1", action: "Read files", behavior: "ask" }],
      }),
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "dark",
      launchAtLogin: true,
      notificationSounds: false,
      microphone: "studio-mic",
      voiceProvider: "openai",
      voiceModel: "gpt-4o-transcribe",
      voiceLanguage: "pt",
      voiceAutoSend: true,
      shortcuts: { voiceInput: "Ctrl+Shift+KeyM" },
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

  it("falls back for voice settings that no longer match a provider", () => {
    expect(
      normalizePreferences({
        voiceProvider: "groq",
        voiceModel: "gpt-4o-transcribe",
        voiceLanguage: "klingon",
        voiceAutoSend: "yes",
        shortcuts: { voiceInput: "KeyM" },
      }),
    ).toMatchObject({
      voiceProvider: "groq",
      voiceModel: "whisper-large-v3-turbo",
      voiceLanguage: "auto",
      voiceAutoSend: false,
      shortcuts: { voiceInput: "Ctrl+Space" },
    });
    expect(normalizePreferences({ voiceProvider: "deepgram" }).voiceProvider).toBe("groq");
  });

  it("never migrates a legacy free-text allow rule into automatic authorization", () => {
    const migrated = normalizePreferences({
      autoReviewRules: [{ id: "legacy", action: "Whatever the model asks", behavior: "allow" }],
    });
    expect(migrated.autoReviewRules).toEqual([
      { id: "legacy", action: "Whatever the model asks", behavior: "ask", scope: "workspace" },
    ]);
  });

  it("preserves integration blocks and never converts them into workspace rules", () => {
    const preferences = normalizePreferences({
      autoReview: false,
      autoReviewRules: [
        { id: "external-block", action: "external_write", behavior: "block", scope: "integration" },
        { id: "file-allow", action: "modify_file", behavior: "allow", scope: "workspace" },
      ],
    });
    expect(normalizePreferences(preferences).autoReviewRules).toEqual([
      { id: "external-block", action: "external_write", behavior: "block", scope: "integration" },
      { id: "file-allow", action: "modify_file", behavior: "allow", scope: "workspace" },
    ]);
    expect(preferences.autoReview).toBe(false);
  });

  it("normalizes integration allow rules to ask and discards unknown scopes", () => {
    expect(
      normalizePreferences({
        autoReviewRules: [
          { id: "external-allow", action: "external_write", behavior: "allow", scope: "integration" },
          { id: "invalid", action: "external_write", behavior: "allow", scope: "global" },
        ],
      }).autoReviewRules,
    ).toEqual([{ id: "external-allow", action: "external_write", behavior: "ask", scope: "integration" }]);
  });
});

it("migrates notification settings and validates saved volume", () => {
  expect(normalizePreferences({ notificationSounds: false })).toEqual({
    ...DEFAULT_PREFERENCES,
    notificationSounds: false,
  });
  for (const value of [NaN, Infinity, "25", null])
    expect(normalizePreferences({ notificationVolume: value }).notificationVolume).toBe(100);
  expect(normalizePreferences({ notificationVolume: -10 }).notificationVolume).toBe(0);
  expect(normalizePreferences({ notificationVolume: 120 }).notificationVolume).toBe(100);
  expect(
    normalizePreferences({
      notificationVolume: 25,
      notifyOnCompletion: false,
      notifyOnApproval: false,
      notifyOnError: false,
      muteActiveConversation: true,
    }),
  ).toMatchObject({
    notificationVolume: 25,
    notifyOnCompletion: false,
    notifyOnApproval: false,
    notifyOnError: false,
    muteActiveConversation: true,
  });
});
