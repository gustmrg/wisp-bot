import { TIME_FORMATS, type TimeFormat } from "@/lib/clock-time";
import { DEFAULT_SHORTCUTS, normalizeShortcuts, type ShortcutPreferences } from "@/lib/shortcuts";
import { DETAILS_LAYOUT, SIDEBAR_LAYOUT, type ResizablePanelLayout } from "@/lib/layout";
import {
  DEFAULT_NOTIFICATION_SOUND,
  isNotificationSoundId,
  type NotificationSoundId,
  type NotificationSoundKind,
} from "@/lib/notification-sounds";
import { normalizeTheme, type ThemePreference } from "@/lib/theme";
import {
  DEFAULT_VOICE_PROVIDER,
  defaultVoiceModel,
  isVoiceLanguage,
  isVoiceModel,
  isVoiceProviderId,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceProviderId,
} from "../../shared/voice";
import { systemTimeZone } from "../../shared/time-zone";

/** How a Wisp's reply appears as it arrives: at once, smoothed, or at a slower, natural pace. */
export type ReplyPace = "instant" | "smooth" | "natural";

export const REPLY_PACES: ReadonlyArray<ReplyPace> = ["instant", "smooth", "natural"];

/** How the conversation list is ordered: latest activity first, or fixed in the order they were created. */
export type ChatListOrder = "recent" | "created";

export const CHAT_LIST_ORDERS: ReadonlyArray<ChatListOrder> = ["recent", "created"];

export type RuleBehavior = "allow" | "ask" | "block";

export interface AutoReviewRule {
  id: string;
  action: string;
  behavior: RuleBehavior;
  scope?: "workspace" | "integration";
}

export interface AppPreferences {
  theme: ThemePreference;
  /** Each Wisp's color tints its replies, its send button and its selected conversation. */
  wispColors: boolean;
  /** How a Wisp's reply appears as it arrives. */
  replyPace: ReplyPace;
  /** Legacy storage only; desktop autostart registration is the source of truth. */
  launchAtLogin: boolean;
  notificationSounds: boolean;
  notificationVolume: number;
  /** The sound each event plays; an event whose switch below is off plays none. */
  notificationSoundIds: Record<NotificationSoundKind, NotificationSoundId>;
  notifyOnCompletion: boolean;
  notifyOnApproval: boolean;
  notifyOnError: boolean;
  muteActiveConversation: boolean;
  /** Native notifications from the desktop app, for the events below. */
  systemNotifications: boolean;
  systemNotifyOnCompletion: boolean;
  systemNotifyOnApproval: boolean;
  systemNotifyOnError: boolean;
  microphone: string;
  voiceProvider: VoiceProviderId;
  voiceModel: string;
  /** The model a recording goes to when the voice provider cannot transcribe it; null when off. */
  voiceFallback: VoiceModelChoice | null;
  voiceLanguage: VoiceLanguage;
  /** Send the message as soon as a recording is transcribed instead of leaving it in the composer. */
  voiceAutoSend: boolean;
  shortcuts: ShortcutPreferences;
  timezone: string;
  /** Clock times in the locale's convention, or always 24-hour or AM/PM. */
  timeFormat: TimeFormat;
  autoReview: boolean;
  autoReviewRules: AutoReviewRule[];
  /** Desktop widths of the Wisp list and the Wisp's settings panel, as last dragged. */
  sidebarWidth: number;
  detailsWidth: number;
  /** The desktop Wisp list is folded to a rail of avatars. */
  sidebarCollapsed: boolean;
  /** The phone list shows every Wisp in a row above the conversations. */
  wispsRow: boolean;
  /** How this device orders the conversation list and the Wisps row. */
  chatListOrder: ChatListOrder;
  /** The last version this device announced, so each update is announced once. */
  announcedVersion: string;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "system",
  wispColors: true,
  replyPace: "smooth",
  launchAtLogin: false,
  notificationSounds: true,
  notificationVolume: 100,
  notificationSoundIds: {
    finished: DEFAULT_NOTIFICATION_SOUND,
    "needs-input": DEFAULT_NOTIFICATION_SOUND,
    error: DEFAULT_NOTIFICATION_SOUND,
  },
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnError: true,
  muteActiveConversation: false,
  systemNotifications: true,
  systemNotifyOnCompletion: true,
  systemNotifyOnApproval: true,
  systemNotifyOnError: true,
  microphone: "default",
  voiceProvider: DEFAULT_VOICE_PROVIDER,
  voiceModel: defaultVoiceModel(DEFAULT_VOICE_PROVIDER),
  voiceFallback: null,
  voiceLanguage: "auto",
  voiceAutoSend: false,
  shortcuts: DEFAULT_SHORTCUTS,
  timezone: "auto",
  timeFormat: "auto",
  autoReview: true,
  autoReviewRules: [],
  sidebarWidth: SIDEBAR_LAYOUT.resize.defaultWidth,
  detailsWidth: DETAILS_LAYOUT.resize.defaultWidth,
  sidebarCollapsed: false,
  wispsRow: true,
  chatListOrder: "recent",
  announcedVersion: "",
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

/** The fallbacks a recording goes to: the saved one, unless it is on the voice provider and would fail along with it. */
export function transcriptionFallbacks(
  preferences: Pick<AppPreferences, "voiceProvider" | "voiceFallback">,
): VoiceModelChoice[] {
  const fallback = preferences.voiceFallback;
  return fallback && fallback.providerId !== preferences.voiceProvider ? [fallback] : [];
}

/** The saved fallback, while it still names a provider and one of its models. */
function voiceFallback(value: unknown): VoiceModelChoice | null {
  const choice = preferenceRecord(value);
  const providerId = choice?.providerId;
  const modelId = choice?.modelId;
  return isVoiceProviderId(providerId) && isVoiceModel(providerId, modelId) ? { providerId, modelId } : null;
}

function panelWidth(value: unknown, { defaultWidth, minWidth, maxWidth }: ResizablePanelLayout): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maxWidth, Math.max(minWidth, Math.round(value)))
    : defaultWidth;
}

/** Each event's saved sound; one this app does not have, or none saved, is the default. */
function normalizeSoundIds(value: unknown): Record<NotificationSoundKind, NotificationSoundId> {
  const saved = preferenceRecord(value);
  const pick = (kind: NotificationSoundKind) => {
    const id = saved?.[kind];
    return isNotificationSoundId(id) ? id : DEFAULT_NOTIFICATION_SOUND;
  };
  return { finished: pick("finished"), "needs-input": pick("needs-input"), error: pick("error") };
}

/** The time zone the person chose, or this device's when they left it on auto-detect. */
export function effectiveTimeZone(preferences: Pick<AppPreferences, "timezone">): string {
  return preferences.timezone === "auto" ? systemTimeZone() : preferences.timezone;
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
    wispColors: typeof saved?.wispColors === "boolean" ? saved.wispColors : true,
    replyPace: REPLY_PACES.includes(saved?.replyPace as ReplyPace) ? (saved?.replyPace as ReplyPace) : "smooth",
    launchAtLogin: typeof saved?.launchAtLogin === "boolean" ? saved.launchAtLogin : false,
    notificationSounds: typeof saved?.notificationSounds === "boolean" ? saved.notificationSounds : true,
    notificationVolume:
      typeof saved?.notificationVolume === "number" && Number.isFinite(saved.notificationVolume)
        ? Math.min(100, Math.max(0, saved.notificationVolume))
        : 100,
    notificationSoundIds: normalizeSoundIds(saved?.notificationSoundIds),
    notifyOnCompletion: typeof saved?.notifyOnCompletion === "boolean" ? saved.notifyOnCompletion : true,
    notifyOnApproval: typeof saved?.notifyOnApproval === "boolean" ? saved.notifyOnApproval : true,
    notifyOnError: typeof saved?.notifyOnError === "boolean" ? saved.notifyOnError : true,
    muteActiveConversation: typeof saved?.muteActiveConversation === "boolean" ? saved.muteActiveConversation : false,
    systemNotifications: typeof saved?.systemNotifications === "boolean" ? saved.systemNotifications : true,
    systemNotifyOnCompletion:
      typeof saved?.systemNotifyOnCompletion === "boolean" ? saved.systemNotifyOnCompletion : true,
    systemNotifyOnApproval: typeof saved?.systemNotifyOnApproval === "boolean" ? saved.systemNotifyOnApproval : true,
    systemNotifyOnError: typeof saved?.systemNotifyOnError === "boolean" ? saved.systemNotifyOnError : true,
    microphone: typeof saved?.microphone === "string" && saved.microphone ? saved.microphone : "default",
    voiceProvider,
    voiceModel: isVoiceModel(voiceProvider, saved?.voiceModel) ? saved.voiceModel : defaultVoiceModel(voiceProvider),
    voiceFallback: voiceFallback(saved?.voiceFallback),
    voiceLanguage: isVoiceLanguage(saved?.voiceLanguage) ? saved.voiceLanguage : "auto",
    voiceAutoSend: typeof saved?.voiceAutoSend === "boolean" ? saved.voiceAutoSend : false,
    shortcuts: normalizeShortcuts(saved?.shortcuts),
    timezone,
    timeFormat: TIME_FORMATS.includes(saved?.timeFormat as TimeFormat) ? (saved?.timeFormat as TimeFormat) : "auto",
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
    sidebarWidth: panelWidth(saved?.sidebarWidth, SIDEBAR_LAYOUT.resize),
    detailsWidth: panelWidth(saved?.detailsWidth, DETAILS_LAYOUT.resize),
    sidebarCollapsed: typeof saved?.sidebarCollapsed === "boolean" ? saved.sidebarCollapsed : false,
    wispsRow: typeof saved?.wispsRow === "boolean" ? saved.wispsRow : true,
    chatListOrder: CHAT_LIST_ORDERS.includes(saved?.chatListOrder as ChatListOrder)
      ? (saved?.chatListOrder as ChatListOrder)
      : "recent",
    announcedVersion: typeof saved?.announcedVersion === "string" ? saved.announcedVersion.slice(0, 64) : "",
  };
}
