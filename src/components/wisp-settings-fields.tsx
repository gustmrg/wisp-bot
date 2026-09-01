import type { AgentSettings } from "@/chat-data";
import { AvatarEditor } from "@/components/avatar-editor";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { detailsField, detailsFieldControl, notificationCard, notificationCardCopy } from "@/lib/ui-classes";

interface WispSettingsFieldsProps {
  settings: AgentSettings;
  onChange: (changes: Partial<AgentSettings>) => void;
}

function WispSettingsFields({ settings, onChange }: WispSettingsFieldsProps) {
  return (
    <>
      <AvatarEditor key={settings.id} chat={settings} onChange={onChange} />
      <label className={detailsField}>
        <span>Name</span>
        <input
          className={detailsFieldControl}
          value={settings.name}
          required
          maxLength={64}
          placeholder="New Wisp"
          onChange={(event) => onChange({ name: event.currentTarget.value })}
        />
      </label>
      <label className={detailsField}>
        <span>Label (optional)</span>
        <input
          className={detailsFieldControl}
          value={settings.label}
          maxLength={40}
          placeholder="Research, marketing, admin"
          onChange={(event) => onChange({ label: event.currentTarget.value })}
        />
      </label>
      <label className={detailsField}>
        <span>Description</span>
        <textarea
          className={detailsFieldControl}
          rows={3}
          value={settings.description}
          maxLength={240}
          placeholder="What this Wisp is for"
          onChange={(event) => onChange({ description: event.currentTarget.value })}
        />
      </label>
      <div className={notificationCard}>
        <span className={notificationCardCopy}>
          <strong className="text-[12.5px]">Notifications</strong>
          <small className="text-dim text-[11px] leading-[1.3]">
            Get notified when this Wisp finishes or needs input
          </small>
        </span>
        <ToggleSwitch
          checked={settings.notifyOnUpdatesEnabled}
          label="Notifications"
          onChange={() => onChange({ notifyOnUpdatesEnabled: !settings.notifyOnUpdatesEnabled })}
        />
      </div>
    </>
  );
}

export { WispSettingsFields };
