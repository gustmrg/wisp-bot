import type { AgentSettings } from "@/chat-data";
import { AvatarEditor } from "@/components/avatar-editor";

interface WispSettingsFieldsProps {
  settings: AgentSettings;
  onChange: (changes: Partial<AgentSettings>) => void;
}

function WispSettingsFields({ settings, onChange }: WispSettingsFieldsProps) {
  return (
    <>
      <AvatarEditor key={settings.id} chat={settings} onChange={onChange} />
      <label className="details-field"><span>Name</span><input value={settings.name} required maxLength={64} placeholder="New Wisp" onChange={(event) => onChange({ name: event.currentTarget.value })} /></label>
      <label className="details-field"><span>Label (optional)</span><input value={settings.label} maxLength={40} placeholder="Research, marketing, admin" onChange={(event) => onChange({ label: event.currentTarget.value })} /></label>
      <label className="details-field"><span>Description</span><textarea rows={3} value={settings.description} maxLength={240} placeholder="What this Wisp is for" onChange={(event) => onChange({ description: event.currentTarget.value })} /></label>
      <div className="notification-card">
        <span><strong>Notifications</strong><small>Get notified when this Wisp finishes or needs input</small></span>
        <button className="switch" data-on={settings.notifyOnUpdatesEnabled} type="button" role="switch" aria-checked={settings.notifyOnUpdatesEnabled} aria-label="Notifications" onClick={() => onChange({ notifyOnUpdatesEnabled: !settings.notifyOnUpdatesEnabled })}><span /></button>
      </div>
    </>
  );
}

export { WispSettingsFields };
