import { DEFAULT_SHORTCUTS, normalizeShortcuts, type ShortcutPreferences } from "@/lib/shortcuts";
import { normalizeTheme, type ThemePreference } from "@/lib/theme";
import {
  DEFAULT_VOICE_PROVIDER,
  defaultVoiceModel,
  isVoiceLanguage,
  isVoiceModel,
  isVoiceProviderId,
  type VoiceLanguage,
  type VoiceProviderId,
} from "../../shared/voice";

export type RuleBehavior = "allow" | "ask" | "block";

export interface AutoReviewRule {
  id: string;
  action: string;
  behavior: RuleBehavior;
  scope?: "workspace" | "integration";
}

export interface AppPreferences {
  theme: ThemePreference;
  /** Legacy storage only; desktop autostart registration is the source of truth. */
  launchAtLogin: boolean;
  notificationSounds: boolean;
  microphone: string;
  voiceProvider: VoiceProviderId;
  voiceModel: string;
  voiceLanguage: VoiceLanguage;
  /** Send the message as soon as a recording is transcribed instead of leaving it in the composer. */
  voiceAutoSend: boolean;
  shortcuts: ShortcutPreferences;
  hardwareAcceleration: boolean;
  timezone: string;
  autoReview: boolean;
  autoReviewRules: AutoReviewRule[];
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "system",
  launchAtLogin: false,
  notificationSounds: true,
  microphone: "default",
  voiceProvider: DEFAULT_VOICE_PROVIDER,
  voiceModel: defaultVoiceModel(DEFAULT_VOICE_PROVIDER),
  voiceLanguage: "auto",
  voiceAutoSend: false,
  shortcuts: DEFAULT_SHORTCUTS,
  hardwareAcceleration: true,
  timezone: "auto",
  autoReview: true,
  autoReviewRules: [],
};

export function isRuleBehavior(value: unknown): value is RuleBehavior {
  return value === "allow" || value === "ask" || value === "block";
}

function isAutoReviewRule(value: unknown): value is AutoReviewRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<AutoReviewRule>;
  return (
    typeof rule.id === "string" &&
    typeof rule.action === "string" &&
    rule.action.trim().length > 0 &&
    rule.action.length <= 240 &&
    isRuleBehavior(rule.behavior) &&
    (rule.scope === undefined || rule.scope === "workspace" || rule.scope === "integration")
  );
}

function preferenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function normalizePreferences(value: unknown): AppPreferences {
  const saved = preferenceRecord(value);
  let timezone = "auto";
  if (typeof saved?.timezone === "string" && saved.timezone && saved.timezone !== "auto") {
    try {
      timezone = new Intl.DateTimeFormat("en", { timeZone: saved.timezone }).resolvedOptions().timeZone;
    } catch {
      // Invalid saved timezones fall back to the device's timezone.
    }
  }
  const voiceProvider = isVoiceProviderId(saved?.voiceProvider) ? saved.voiceProvider : DEFAULT_VOICE_PROVIDER;
  return {
    theme: normalizeTheme(saved?.theme),
    launchAtLogin: typeof saved?.launchAtLogin === "boolean" ? saved.launchAtLogin : false,
    notificationSounds: typeof saved?.notificationSounds === "boolean" ? saved.notificationSounds : true,
    microphone: typeof saved?.microphone === "string" && saved.microphone ? saved.microphone : "default",
    voiceProvider,
    voiceModel: isVoiceModel(voiceProvider, saved?.voiceModel) ? saved.voiceModel : defaultVoiceModel(voiceProvider),
    voiceLanguage: isVoiceLanguage(saved?.voiceLanguage) ? saved.voiceLanguage : "auto",
    voiceAutoSend: typeof saved?.voiceAutoSend === "boolean" ? saved.voiceAutoSend : false,
    shortcuts: normalizeShortcuts(saved?.shortcuts),
    hardwareAcceleration: typeof saved?.hardwareAcceleration === "boolean" ? saved.hardwareAcceleration : true,
    timezone,
    autoReview: typeof saved?.autoReview === "boolean" ? saved.autoReview : true,
    autoReviewRules: Array.isArray(saved?.autoReviewRules)
      ? saved.autoReviewRules.filter(isAutoReviewRule).map((rule) => ({
          ...rule,
          behavior:
            (rule.scope === undefined || rule.scope === "integration") && rule.behavior === "allow"
              ? "ask"
              : rule.behavior,
          scope: rule.scope ?? "workspace",
        }))
      : [],
  };
}
