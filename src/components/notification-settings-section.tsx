import { PreferenceSwitch } from "@/components/general-settings-sections";
import { SettingsCard, SettingsGroup, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import type { PersistenceStatus } from "@/features/persistence/storage-policy";
import type { AppPreferences } from "@/lib/app-preferences";
import { playNotificationSound } from "@/lib/notification-sounds";

const EVENTS = [
  {
    key: "notifyOnCompletion",
    label: "Response completed",
    description: "When a Wisp finishes its turn.",
    sound: "finished",
  },
  {
    key: "notifyOnApproval",
    label: "Approval needed",
    description: "When a Wisp needs permission to use a tool.",
    sound: "needs-input",
  },
  { key: "notifyOnError", label: "Execution error", description: "When a Wisp encounters an error.", sound: "error" },
] as const;

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
        <SettingsGroup label="Sounds">
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <strong>Notification sounds</strong>
                <small>Play sounds for Wisp updates.</small>
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
                <label htmlFor="notification-volume">
                  <strong>Volume</strong>
                </label>
                <small>Adjust the volume of all notification sounds.</small>
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
          </SettingsCard>
        </SettingsGroup>
        <SettingsGroup label="Events">
          <SettingsCard variant="stacked">
            {EVENTS.map(({ key, label, description, sound }) => (
              <SettingsRow key={key}>
                <SettingsRowCopy>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </SettingsRowCopy>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Test sound: ${label}`}
                    disabled={!preferences.notificationSounds || preferences.notificationVolume === 0}
                    onClick={() => playNotificationSound(sound, preferences.notificationVolume)}
                  >
                    Test
                  </Button>
                  <PreferenceSwitch
                    label={label}
                    checked={preferences[key]}
                    disabled={!preferences.notificationSounds}
                    onChange={() => onPreferencesChange({ ...preferences, [key]: !preferences[key] })}
                  />
                </div>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsGroup>
        <SettingsGroup label="When to notify">
          <SettingsCard>
            <SettingsRow>
              <SettingsRowCopy>
                <strong>Mute the open conversation</strong>
                <small>Skip sounds for the selected conversation while this window is in focus.</small>
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
