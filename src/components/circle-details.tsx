import { type ReactNode, useState } from "react";

import { circleLeadId, withCircleLead } from "../../shared/conversations";
import type { CircleChatChanges, CircleChatView, WispCollection, WispId } from "@/chat-data";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { cn } from "@/lib/utils";
import { ChatAvatar } from "@/components/chat-avatar";
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
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { RuntimeEventsSection } from "@/components/runtime-events-section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsageReportPanel } from "@/components/usage-settings-section";
import { WispWorkspaceSettings } from "@/components/wisp-workspace-settings";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const TAB_ORDER = ["general", "members", "workspace", "usage"] as const;

/** The tabs of a circle's settings. */
export type CircleSettingsTab = (typeof TAB_ORDER)[number];

interface CircleDetailsProps {
  chat: CircleChatView;
  wisps: WispCollection;
  /** Saves the circle's settings. */
  onChange: (changes: CircleChatChanges) => Promise<boolean> | void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
  actions?: ReactNode;
  /** The tab shown first. */
  initialTab?: CircleSettingsTab;
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

export function CircleDetails({
  chat,
  wisps,
  onChange,
  onOpenSettings,
  actions,
  initialTab = "general",
}: CircleDetailsProps) {
  const [tab, setTab] = useState<CircleSettingsTab>(initialTab);
  const [slideDirection, setSlideDirection] = useState<"forward" | "back">("forward");
  const [visited, setVisited] = useState(() => new Set<string>(["general", initialTab]));
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
  const slideClass = slideDirection === "forward" ? "animate-tab-forward" : "animate-tab-back";

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
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (typeof value !== "string") return;
        const nextIndex = TAB_ORDER.indexOf(value as CircleSettingsTab);
        const currentIndex = TAB_ORDER.indexOf(tab);
        if (nextIndex < 0) return;
        if (nextIndex !== currentIndex) setSlideDirection(nextIndex > currentIndex ? "forward" : "back");
        setTab(value as CircleSettingsTab);
        setVisited((current) => (current.has(value) ? current : new Set([...current, value])));
      }}
      className="min-h-0 flex-1 gap-0 overflow-hidden"
    >
      <div className="flex-none border-b border-border px-3.5 py-3">
        <TabsList className="w-full" aria-label="Circle settings sections">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent
        value="general"
        keepMounted
        className={cn("min-h-0 overflow-y-auto p-3.5", tab === "general" && slideClass)}
      >
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
        {actions ? <SettingsActions className="mt-[18px]">{actions}</SettingsActions> : null}
      </TabsContent>
      <TabsContent
        value="members"
        keepMounted
        className={cn("min-h-0 overflow-y-auto p-3.5", tab === "members" && slideClass)}
      >
        <CircleMemberPicker
          label={`Participants (${members.length})`}
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
      </TabsContent>
      {/* The workspace saves its own changes. */}
      <TabsContent
        value="workspace"
        keepMounted
        className={cn("min-h-0 overflow-y-auto p-3.5", tab === "workspace" && slideClass)}
      >
        {visited.has("workspace") ? (
          <WispWorkspaceSettings conversationId={chat.id} kind="circle" onOpenSettings={onOpenSettings} />
        ) : null}
      </TabsContent>
      <TabsContent
        value="usage"
        keepMounted
        className={cn("min-h-0 overflow-y-auto p-3.5", tab === "usage" && slideClass)}
      >
        {visited.has("usage") ? (
          <>
            <UsageReportPanel conversationId={chat.id} wisps={chat.members} active={tab === "usage"} />
            <RuntimeEventsSection conversationId={chat.id} active={tab === "usage"} />
          </>
        ) : null}
      </TabsContent>
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
    </Tabs>
  );
}
