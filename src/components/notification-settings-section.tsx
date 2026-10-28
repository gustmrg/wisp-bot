import { PlayIcon } from "lucide-react";

import { PreferenceSwitch } from "@/components/general-settings-sections";
import {
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import type { AppPreferences } from "@/lib/app-preferences";
import { NOTIFICATION_SOUNDS, isNotificationSoundId, playNotificationSound } from "@/lib/notification-sounds";

const EVENTS = [
  {
    key: "notifyOnCompletion",
    systemKey: "systemNotifyOnCompletion",
    label: "Response completed",
    description: "When a Wisp finishes its turn.",
    sound: "finished",
  },
  {
    key: "notifyOnApproval",
    systemKey: "systemNotifyOnApproval",
    label: "Approval needed",
    description: "When a Wisp needs permission to use a tool.",
    sound: "needs-input",
  },
  {
    key: "notifyOnError",
    systemKey: "systemNotifyOnError",
    label: "Execution error",
    description: "When a Wisp encounters an error.",
    sound: "error",
  },
] as const;

// Both channel columns share one width so the header lines up with each row's test button and switch.
const CHANNEL_COLUMN = "flex w-[72px] shrink-0 items-center justify-end gap-1.5";
// The sound column holds a test button and the sound select.
const SOUND_COLUMN = "flex w-[160px] shrink-0 items-center justify-end gap-1.5";
/** The select's value for an event that plays no sound. */
const NO_SOUND = "none";
const SOUND_OPTIONS = [
  { value: NO_SOUND, label: "None" },
  ...NOTIFICATION_SOUNDS.map(({ id, label }) => ({ value: id, label })),
];

interface Props {
  preferences: AppPreferences;
  onPreferencesChange: (preferences: AppPreferences) => void;
  persistenceStatus: PersistenceStatus;
  persistenceError: string | null;
}

export function NotificationSettingsSection({
  preferences,
  onPreferencesChange,
  persistenceStatus,
  persistenceError,
}: Props) {
  // Only the desktop app has native notifications.
  const systemNotifications = window.wisp?.systemNotifications;
  return (
    <section
      id="notification-settings-panel"
      aria-labelledby="notification-settings-title"
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
    >
      <h2 id="notification-settings-title" className="mb-[22px] mt-0 text-lg font-semibold">
        Notifications
      </h2>
      <div className="animate-tab-forward">
        <SettingsGroup label="Channels">
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle>Notification sounds</SettingsRowTitle>
                <SettingsRowDescription>Play sounds for Wisp updates.</SettingsRowDescription>
              </SettingsRowCopy>
              <PreferenceSwitch
                label="Notification sounds"
                checked={preferences.notificationSounds}
                onChange={() =>
                  onPreferencesChange({ ...preferences, notificationSounds: !preferences.notificationSounds })
                }
              />
            </SettingsRow>
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle htmlFor="notification-volume">Volume</SettingsRowTitle>
                <SettingsRowDescription>Adjust the volume of all notification sounds.</SettingsRowDescription>
              </SettingsRowCopy>
              <div className="flex shrink-0 items-center gap-2">
                <input
                  id="notification-volume"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  className="w-24 accent-primary"
                  value={preferences.notificationVolume}
                  aria-valuetext={`${preferences.notificationVolume}%`}
                  disabled={!preferences.notificationSounds}
                  onChange={(event) =>
                    onPreferencesChange({ ...preferences, notificationVolume: Number(event.target.value) })
                  }
                />
                <output htmlFor="notification-volume" className="w-9 text-right text-xs">
                  {preferences.notificationVolume}%
                </output>
              </div>
            </SettingsRow>
            {systemNotifications ? (
              <SettingsRow>
                <SettingsRowCopy>
                  <SettingsRowTitle>System notifications</SettingsRowTitle>
                  <SettingsRowDescription>
                    Show Wisp updates in your system's notifications, even with Wisp in the background or its window
                    closed. Click one to open the conversation.
                  </SettingsRowDescription>
                </SettingsRowCopy>
                <PreferenceSwitch
                  label="System notifications"
                  checked={preferences.systemNotifications}
                  onChange={() =>
                    onPreferencesChange({ ...preferences, systemNotifications: !preferences.systemNotifications })
                  }
                />
              </SettingsRow>
            ) : null}
          </SettingsCard>
        </SettingsGroup>
        <SettingsGroup label="Events">
          <SettingsCard variant="stacked">
            <div className="flex items-center gap-3 px-3.5 py-2 text-xs text-dim" aria-hidden="true">
              <span className="flex-1">Notify me when</span>
              <span className={SOUND_COLUMN}>Sound</span>
              {systemNotifications ? <span className={CHANNEL_COLUMN}>System</span> : null}
            </div>
            {EVENTS.map(({ key, systemKey, label, description, sound }) => (
              <SettingsRow key={key}>
                <SettingsRowCopy>
                  <SettingsRowTitle>{label}</SettingsRowTitle>
                  <SettingsRowDescription>{description}</SettingsRowDescription>
                </SettingsRowCopy>
                {/* Both channels wrap together, beneath the event on a narrow screen. */}
                <div className="ml-auto flex items-center gap-3">
                  <div className={SOUND_COLUMN}>
                    <TestButton
                      label={`Test sound: ${label}`}
                      disabled={
                        !preferences.notificationSounds || !preferences[key] || preferences.notificationVolume === 0
                      }
                      onClick={() =>
                        playNotificationSound(
                          sound,
                          preferences.notificationVolume,
                          preferences.notificationSoundIds[sound],
                        )
                      }
                    />
                    <Select
                      items={SOUND_OPTIONS}
                      value={preferences[key] ? preferences.notificationSoundIds[sound] : NO_SOUND}
                      disabled={!preferences.notificationSounds}
                      onValueChange={(value) => {
                        if (value === NO_SOUND) {
                          onPreferencesChange({ ...preferences, [key]: false });
                          return;
                        }
                        if (!isNotificationSoundId(value)) return;
                        onPreferencesChange({
                          ...preferences,
                          [key]: true,
                          notificationSoundIds: { ...preferences.notificationSoundIds, [sound]: value },
                        });
                        // Choosing a sound is hearing it.
                        playNotificationSound(sound, preferences.notificationVolume, value);
                      }}
                    >
                      <SelectTrigger aria-label={`Sound: ${label}`} className="w-[112px] flex-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" alignItemWithTrigger={false}>
                        <SelectGroup>
                          {SOUND_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  {systemNotifications ? (
                    <div className={CHANNEL_COLUMN}>
                      <TestButton
                        label={`Test notification: ${label}`}
                        disabled={!preferences.systemNotifications}
                        onClick={() => void systemNotifications.test({ kind: sound }).catch(() => undefined)}
                      />
                      <PreferenceSwitch
                        label={`Notification: ${label}`}
                        checked={preferences[systemKey]}
                        disabled={!preferences.systemNotifications}
                        onChange={() => onPreferencesChange({ ...preferences, [systemKey]: !preferences[systemKey] })}
                      />
                    </div>
                  ) : null}
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsGroup>
        <SettingsGroup label="Behavior">
          <SettingsCard>
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle>Mute the open conversation</SettingsRowTitle>
                <SettingsRowDescription>
                  While this window is in focus, skip sounds for the conversation you're viewing.
                </SettingsRowDescription>
              </SettingsRowCopy>
              <PreferenceSwitch
                label="Mute the open conversation"
                checked={preferences.muteActiveConversation}
                disabled={!preferences.notificationSounds}
                onChange={() =>
                  onPreferencesChange({ ...preferences, muteActiveConversation: !preferences.muteActiveConversation })
                }
              />
            </SettingsRow>
          </SettingsCard>
          <p className="mx-0.5 mt-[7px] text-dim text-xs leading-[1.45]">
            Wisps with notifications turned off in their own settings stay silent.
            {systemNotifications
              ? " System notifications skip the conversation on screen while Wisp is in focus. If none show up, check that your system allows notifications from Wisp."
              : null}
          </p>
        </SettingsGroup>
        <p className="mt-4 text-xs text-dim" role={persistenceError ? "alert" : "status"} aria-live="polite">
          {persistenceError ??
            (persistenceStatus === "saving"
              ? "Saving preferences…"
              : persistenceStatus === "saved"
                ? "Preferences saved on this device."
                : "Preferences are stored on this device.")}
        </p>
      </div>
    </section>
  );
}

function TestButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <PlayIcon aria-hidden="true" />
    </Button>
  );
}
