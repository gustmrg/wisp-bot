import { type ReactNode, useState } from "react";

import { circleLeadId, withCircleLead } from "../../shared/conversations";
import type { CircleChatChanges, CircleChatView, WispCollection, WispId } from "@/chat-data";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { ChatAvatar, WispAvatar } from "@/components/chat-avatar";
import { CircleLeadPicker } from "@/components/circle-lead-picker";
import { CircleMemberPicker } from "@/components/circle-member-picker";
import {
  SettingsActions,
  SettingsCard,
  SettingsField,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SettingsAccordionSection } from "@/components/wisp-details";
import { WispWorkspaceSettings } from "@/components/wisp-workspace-settings";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface CircleDetailsProps {
  chat: CircleChatView;
  wisps: WispCollection;
  /** Saves the circle's settings. */
  onChange: (changes: CircleChatChanges) => Promise<boolean> | void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
  actions?: ReactNode;
}

interface CircleSettingsDraft {
  name: string;
  label: string;
  description: string;
  memberIds: ReadonlyArray<WispId>;
  notifyOnUpdatesEnabled: boolean;
}

function draftOf(chat: CircleChatView): CircleSettingsDraft {
  const { name, label, description, memberIds, notifyOnUpdatesEnabled } = chat;
  return { name, label, description, memberIds, notifyOnUpdatesEnabled };
}

function sameIds(a: ReadonlyArray<WispId>, b: ReadonlyArray<WispId>): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function CircleDetails({ chat, wisps, onChange, onOpenSettings, actions }: CircleDetailsProps) {
  const [draft, setDraft] = useState(() => draftOf(chat));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const availableWisps = Object.values(wisps);
  // The draft's members, shown before they are saved.
  const members = draft.memberIds.flatMap((id) => {
    const wisp = wisps[id] ?? chat.members.find((member) => member.id === id);
    return wisp ? [wisp] : [];
  });
  const changes: CircleChatChanges = {
    kind: "circle",
    ...(draft.name !== chat.name && { name: draft.name }),
    ...(draft.label !== chat.label && { label: draft.label }),
    ...(draft.description !== chat.description && { description: draft.description }),
    ...(!sameIds(draft.memberIds, chat.memberIds) && { memberIds: draft.memberIds }),
    ...(draft.notifyOnUpdatesEnabled !== chat.notifyOnUpdatesEnabled && {
      notifyOnUpdatesEnabled: draft.notifyOnUpdatesEnabled,
    }),
  };
  const changed = Object.keys(changes).length > 1;

  function edit(next: Partial<CircleSettingsDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  async function save() {
    const name = draft.name.trim() || "Untitled";
    setSaving(true);
    setError("");
    try {
      if ((await onChange("name" in changes ? { ...changes, name } : changes)) === false) {
        setError("Could not save circle settings.");
        return;
      }
      edit({ name });
    } catch {
      setError("Could not save circle settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        <div className="flex justify-center pt-5 pb-[30px]">
          <ChatAvatar chat={{ ...chat, members }} size="xl" />
        </div>
        <SettingsField label="Name">
          <Input value={draft.name} maxLength={64} onChange={(event) => edit({ name: event.currentTarget.value })} />
        </SettingsField>
        <SettingsField label="Label (optional)">
          <Input
            value={draft.label}
            maxLength={40}
            placeholder="Research, marketing, admin"
            onChange={(event) => edit({ label: event.currentTarget.value })}
          />
        </SettingsField>
        <SettingsField label="Description">
          <Textarea
            rows={3}
            value={draft.description}
            maxLength={240}
            onChange={(event) => edit({ description: event.currentTarget.value })}
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
          selectedIds={draft.memberIds}
          onChange={(memberIds) => edit({ memberIds })}
        />
        <div className="mt-[15px]">
          <CircleLeadPicker
            members={members}
            leadId={circleLeadId(draft)}
            onChange={(leadId) => edit({ memberIds: withCircleLead(draft.memberIds, leadId) })}
          />
        </div>
        <SettingsCard className="mt-[15px]">
          <SettingsRow className="min-h-0 p-[11px]">
            <SettingsRowCopy>
              <SettingsRowTitle>Notifications</SettingsRowTitle>
              <SettingsRowDescription>Get notified about activity in this circle</SettingsRowDescription>
            </SettingsRowCopy>
            <ToggleSwitch
              checked={draft.notifyOnUpdatesEnabled}
              label="Notifications"
              onChange={() => edit({ notifyOnUpdatesEnabled: !draft.notifyOnUpdatesEnabled })}
            />
          </SettingsRow>
        </SettingsCard>
        {/* The workspace saves its own changes. */}
        <Accordion multiple className="mt-4 border-t border-border">
          <SettingsAccordionSection value="workspace" label="Workspace">
            <WispWorkspaceSettings conversationId={chat.id} kind="circle" onOpenSettings={onOpenSettings} />
          </SettingsAccordionSection>
        </Accordion>
        {actions ? <SettingsActions className="mt-[18px]">{actions}</SettingsActions> : null}
      </div>
      {changed ? (
        <footer className="flex flex-none flex-col gap-3 border-t border-border p-3.5">
          <FormStatus error={error} />
          <div className="flex gap-2 min-[761px]:justify-end">
            <Button
              className="max-[760px]:flex-1"
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setDraft(draftOf(chat));
                setError("");
              }}
            >
              Discard
            </Button>
            <Button className="max-[760px]:flex-1" type="button" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save circle"}
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
