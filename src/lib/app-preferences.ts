import { normalizeTheme, type ThemePreference } from "@/lib/theme";

export type RuleBehavior = "allow" | "ask" | "block";

export interface AutoReviewRule {
  id: string;
  action: string;
  behavior: RuleBehavior;
}

export interface AppPreferences {
  theme: ThemePreference;
  launchAtLogin: boolean;
  notificationSounds: boolean;
  microphone: string;
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
  return typeof rule.id === "string" && typeof rule.action === "string"
    && rule.action.trim().length > 0 && rule.action.length <= 240 && isRuleBehavior(rule.behavior);
}

export function normalizePreferences(value: Partial<AppPreferences> | undefined): AppPreferences {
  let timezone = "auto";
  if (value?.timezone && value.timezone !== "auto") {
    try {
      timezone = new Intl.DateTimeFormat("en", { timeZone: value.timezone }).resolvedOptions().timeZone;
    } catch {
      // Invalid saved timezones fall back to the device's timezone.
    }
  }
  return {
    theme: normalizeTheme(value?.theme),
    launchAtLogin: typeof value?.launchAtLogin === "boolean" ? value.launchAtLogin : false,
    notificationSounds: typeof value?.notificationSounds === "boolean" ? value.notificationSounds : true,
    microphone: typeof value?.microphone === "string" && value.microphone ? value.microphone : "default",
    hardwareAcceleration: typeof value?.hardwareAcceleration === "boolean" ? value.hardwareAcceleration : true,
    timezone,
    autoReview: typeof value?.autoReview === "boolean" ? value.autoReview : true,
    autoReviewRules: Array.isArray(value?.autoReviewRules) ? value.autoReviewRules.filter(isAutoReviewRule) : [],
  };
}
