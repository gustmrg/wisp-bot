import type { WispChatChanges, WispSummary } from "@/chat-data";
import { AvatarEditor } from "@/components/avatar-editor";
import { SettingsCard, SettingsField, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WispToneFields } from "@/components/wisp-tone-fields";

interface WispSettingsFieldsProps {
  settings: WispSummary;
  onChange: (changes: Omit<WispChatChanges, "kind">) => void;
}

const WISP_PERSONALITY_MAX_LENGTH = 4_000;

/** Appearance, name, and label: how the Wisp shows up in the app. */
function WispIdentityFields({ settings, onChange }: WispSettingsFieldsProps) {
  return (
    <>
      <AvatarEditor key={settings.id} chat={settings} onChange={onChange} />
      <SettingsField label="Name">
        <Input
          value={settings.name}
          required
          maxLength={64}
          placeholder="New Wisp"
          onChange={(event) => onChange({ name: event.currentTarget.value })}
        />
      </SettingsField>
      <SettingsField label="Label (optional)">
        <Input
          value={settings.label}
          maxLength={40}
          placeholder="Research, marketing, admin"
          onChange={(event) => onChange({ label: event.currentTarget.value })}
        />
      </SettingsField>
    </>
  );
}

/** Personality, tone, and notifications: how the Wisp works. */
function WispBehaviorFields({ settings, onChange }: WispSettingsFieldsProps) {
  return (
    <>
      <SettingsField label="Identity & personality">
        <Textarea
          rows={5}
          value={settings.description}
          maxLength={WISP_PERSONALITY_MAX_LENGTH}
          placeholder="Define who this Wisp is, its expertise, tone, and behavior"
          onChange={(event) => onChange({ description: event.currentTarget.value })}
        />
      </SettingsField>
      <WispToneFields tone={settings.tone} onChange={(tone) => onChange({ tone })} />
      <SettingsCard className="mt-[15px]">
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <strong className="text-sm">Notifications</strong>
            <small className="text-dim text-xs leading-[1.3]">
              Get notified when this Wisp finishes or needs input
            </small>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={settings.notifyOnUpdatesEnabled}
            label="Notifications"
            onChange={() => onChange({ notifyOnUpdatesEnabled: !settings.notifyOnUpdatesEnabled })}
          />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}

function WispSettingsFields(props: WispSettingsFieldsProps) {
  return (
    <>
      <WispIdentityFields {...props} />
      <WispBehaviorFields {...props} />
    </>
  );
}

export { WispBehaviorFields, WispIdentityFields, WispSettingsFields };
