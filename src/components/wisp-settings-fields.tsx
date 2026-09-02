import type { WispChat, WispChatChanges } from "@/chat-data";
import { AvatarEditor } from "@/components/avatar-editor";
import { SettingsCard, SettingsField, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface WispSettingsFieldsProps {
  settings: WispChat;
  onChange: (changes: Omit<WispChatChanges, "kind">) => void;
}

function WispSettingsFields({ settings, onChange }: WispSettingsFieldsProps) {
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
      <SettingsField label="Description">
        <Textarea
          rows={3}
          value={settings.description}
          maxLength={240}
          placeholder="What this Wisp is for"
          onChange={(event) => onChange({ description: event.currentTarget.value })}
        />
      </SettingsField>
      <SettingsCard className="mt-[15px]">
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <strong className="text-[12.5px]">Notifications</strong>
            <small className="text-dim text-[11px] leading-[1.3]">
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

export { WispSettingsFields };
