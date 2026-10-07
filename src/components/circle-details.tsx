import type { CircleChatChanges, CircleChatView, WispCollection } from "@/chat-data";
import { ChatAvatar, WispAvatar } from "@/components/chat-avatar";
import { CircleMemberPicker } from "@/components/circle-member-picker";
import { SettingsCard, SettingsField, SettingsRow, SettingsRowCopy } from "@/components/settings/settings-primitives";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface CircleDetailsProps {
  chat: CircleChatView;
  wisps: WispCollection;
  onChange: (changes: CircleChatChanges) => void;
}

export function CircleDetails({ chat, wisps, onChange }: CircleDetailsProps) {
  const members = chat.members;
  const availableWisps = Object.values(wisps);
  return (
    <>
      <div className="flex justify-center pt-5 pb-[30px]">
        <ChatAvatar chat={chat} size="xl" />
      </div>
      <SettingsField label="Name">
        <Input
          value={chat.name}
          maxLength={64}
          onChange={(event) => onChange({ kind: "circle", name: event.currentTarget.value || "Untitled" })}
        />
      </SettingsField>
      <SettingsField label="Label (optional)">
        <Input
          value={chat.label}
          maxLength={40}
          placeholder="Research, marketing, admin"
          onChange={(event) => onChange({ kind: "circle", label: event.currentTarget.value })}
        />
      </SettingsField>
      <SettingsField label="Description">
        <Textarea
          rows={3}
          value={chat.description}
          maxLength={240}
          onChange={(event) => onChange({ kind: "circle", description: event.currentTarget.value })}
        />
      </SettingsField>
      <section className="my-4" aria-labelledby="circle-participants-title">
        <h3 id="circle-participants-title" className="mb-2 mt-0 text-dim text-sm font-medium">
          Participants ({members.length})
        </h3>
        {members.length ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-2">
                <WispAvatar wisp={member} size="sm" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{member.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-dim text-sm">No Wisps in this circle.</p>
        )}
      </section>
      <CircleMemberPicker
        label="Edit participants"
        availableWisps={availableWisps}
        selectedIds={chat.memberIds}
        onChange={(memberIds) => onChange({ kind: "circle", memberIds })}
      />
      <SettingsCard className="mt-[15px]">
        <SettingsRow className="min-h-0 p-[11px]">
          <SettingsRowCopy>
            <strong className="text-sm">Notifications</strong>
            <small className="text-dim text-xs leading-[1.3]">Get notified about activity in this circle</small>
          </SettingsRowCopy>
          <ToggleSwitch
            checked={chat.notifyOnUpdatesEnabled}
            label="Notifications"
            onChange={() => onChange({ kind: "circle", notifyOnUpdatesEnabled: !chat.notifyOnUpdatesEnabled })}
          />
        </SettingsRow>
      </SettingsCard>
    </>
  );
}
