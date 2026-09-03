import { normalizeTheme, type ThemePreference } from "@/lib/theme";

export type RuleBehavior = "allow" | "ask" | "block";

export interface AutoReviewRule {
  id: string;
  action: string;
  behavior: RuleBehavior;
  scope?: "workspace";
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
  return (
    typeof rule.id === "string" &&
    typeof rule.action === "string" &&
    rule.action.trim().length > 0 &&
    rule.action.length <= 240 &&
    isRuleBehavior(rule.behavior) &&
    (rule.scope === undefined || rule.scope === "workspace")
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
  return {
    theme: normalizeTheme(saved?.theme),
    launchAtLogin: typeof saved?.launchAtLogin === "boolean" ? saved.launchAtLogin : false,
    notificationSounds: typeof saved?.notificationSounds === "boolean" ? saved.notificationSounds : true,
    microphone: typeof saved?.microphone === "string" && saved.microphone ? saved.microphone : "default",
    hardwareAcceleration: typeof saved?.hardwareAcceleration === "boolean" ? saved.hardwareAcceleration : true,
    timezone,
    autoReview: typeof saved?.autoReview === "boolean" ? saved.autoReview : true,
    autoReviewRules: Array.isArray(saved?.autoReviewRules)
      ? saved.autoReviewRules.filter(isAutoReviewRule).map((rule) => ({
          ...rule,
          behavior: rule.scope === undefined && rule.behavior === "allow" ? "ask" : rule.behavior,
          scope: "workspace",
        }))
      : [],
  };
}
