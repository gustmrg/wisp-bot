import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, normalizePreferences } from "@/lib/app-preferences";

describe("normalizePreferences", () => {
  it("keeps a known conversation order and falls back to latest activity", () => {
    expect(normalizePreferences({ chatListOrder: "created" }).chatListOrder).toBe("created");
    expect(normalizePreferences({ chatListOrder: "alphabetical" }).chatListOrder).toBe("recent");
  });

  it("keeps up to two valid voice backups, without repeats", () => {
    expect(
      normalizePreferences({
        voiceFallbacks: [
          { providerId: "openai", modelId: "whisper-1" },
          { providerId: "openai", modelId: "whisper-1" },
          { providerId: "openai", modelId: "voxtral-mini-latest" },
          { providerId: "deepgram", modelId: "nova" },
          { providerId: "mistral", modelId: "voxtral-mini-latest" },
          { providerId: "groq", modelId: "whisper-large-v3" },
        ],
      }).voiceFallbacks,
    ).toEqual([
      { providerId: "openai", modelId: "whisper-1" },
      { providerId: "mistral", modelId: "voxtral-mini-latest" },
    ]);
    expect(normalizePreferences({ voiceFallbacks: "openai" }).voiceFallbacks).toEqual([]);
  });

  it("returns defaults when no saved preferences exist", () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  it("preserves valid preferences", () => {
    expect(
      normalizePreferences({
        theme: "dark",
        wispColors: false,
        wispsRow: false,
        launchAtLogin: true,
        notificationSounds: false,
        microphone: "studio-mic",
        voiceProvider: "openai",
        voiceModel: "gpt-4o-transcribe",
        voiceLanguage: "pt",
        voiceAutoSend: true,
        shortcuts: { voiceInput: "Ctrl+Shift+KeyM" },
        timezone: "UTC",
        timeFormat: "24h",
        autoReview: false,
        autoReviewRules: [{ id: "rule-1", action: "Read files", behavior: "ask" }],
      }),
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "dark",
      wispColors: false,
      wispsRow: false,
      launchAtLogin: true,
      notificationSounds: false,
      microphone: "studio-mic",
      voiceProvider: "openai",
      voiceModel: "gpt-4o-transcribe",
      voiceLanguage: "pt",
      voiceAutoSend: true,
      shortcuts: { voiceInput: "Ctrl+Shift+KeyM" },
      timezone: "UTC",
      timeFormat: "24h",
      autoReview: false,
      autoReviewRules: [{ id: "rule-1", action: "Read files", behavior: "ask", scope: "workspace" }],
    });
  });

  it("keeps a known time format and follows the system otherwise", () => {
    expect(normalizePreferences({ timeFormat: "12h" }).timeFormat).toBe("12h");
    expect(normalizePreferences({ timeFormat: "military" }).timeFormat).toBe("auto");
    expect(normalizePreferences({}).timeFormat).toBe("auto");
  });

  it("keeps a known reply speed and smooths replies otherwise", () => {
    expect(normalizePreferences({ replyPace: "natural" }).replyPace).toBe("natural");
    expect(normalizePreferences({ replyPace: "warp" }).replyPace).toBe("smooth");
    expect(normalizePreferences({}).replyPace).toBe("smooth");
  });

  it("remembers whether the sidebar is collapsed", () => {
    expect(normalizePreferences({ sidebarCollapsed: true }).sidebarCollapsed).toBe(true);
    expect(normalizePreferences({ sidebarCollapsed: "yes" }).sidebarCollapsed).toBe(false);
    expect(normalizePreferences({}).sidebarCollapsed).toBe(false);
  });

  it("keeps saved panel widths within each panel's bounds", () => {
    expect(normalizePreferences({ sidebarWidth: 312.4, detailsWidth: 9000 })).toMatchObject({
      sidebarWidth: 312,
      detailsWidth: 480,
    });
    expect(normalizePreferences({ sidebarWidth: 10, detailsWidth: "wide" })).toMatchObject({
      sidebarWidth: 220,
      detailsWidth: 400,
    });
  });

  it("falls back for invalid values and removes malformed rules", () => {
    expect(
      normalizePreferences({
        theme: "sepia" as never,
        launchAtLogin: "yes" as never,
        notificationSounds: 1 as never,
        microphone: "",
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
