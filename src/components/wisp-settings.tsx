import {
  BarChart3Icon,
  BrainIcon,
  CalendarClockIcon,
  CpuIcon,
  FolderIcon,
  KeyRoundIcon,
  type LucideIcon,
  PencilIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";

import type { WispChanges, WispChatView } from "@/chat-data";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { WispContextSettings } from "@/components/wisp-context-settings";
import { WispExecutionSettings } from "@/components/wisp-execution-settings";
import { WispJobSettings } from "@/components/wisp-job-settings";
import { WispMemorySettings } from "@/components/wisp-memory-settings";
import { WispModelSettings } from "@/components/wisp-model-settings";
import { WispPluginSettings } from "@/components/wisp-plugin-settings";
import { WispSessionReportSection } from "@/components/wisp-session-report";
import { WispIdentityFields, type WispSettingsDraft, WispSoulField } from "@/components/wisp-settings-fields";
import { WispSkillSettings } from "@/components/wisp-skill-settings";
import { WispWorkspaceSettings } from "@/components/wisp-workspace-settings";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { sameWispAppearance } from "../../shared/wisp-appearance";

/** A page of a Wisp's settings: one topic each, opened from its profile. */
export type WispSettingsSection =
  | "profile"
  | "model"
  | "access"
  | "usage"
  | "memory"
  | "skills"
  | "workspace"
  | "execution"
  | "jobs";

export interface WispSettingsSectionInfo {
  section: WispSettingsSection;
  label: string;
  icon: LucideIcon;
  /** What the section holds, where a profile row has room to say it. */
  description: string;
}

/** The profile's own shortcuts: what it is, and how it thinks and reaches out. */
export const WISP_SETTINGS_MAIN: ReadonlyArray<WispSettingsSectionInfo> = [
  { section: "profile", label: "Profile", icon: PencilIcon, description: "Appearance, name, role, and soul" },
  { section: "model", label: "Model", icon: CpuIcon, description: "The model it runs on" },
  { section: "access", label: "Access", icon: KeyRoundIcon, description: "Tools and plugins it can use" },
  { section: "usage", label: "Usage", icon: BarChart3Icon, description: "Tokens and cost" },
];

/** What the Wisp knows and does, under the shortcuts. */
export const WISP_SETTINGS_MORE: ReadonlyArray<WispSettingsSectionInfo> = [
  { section: "memory", label: "Memory", icon: BrainIcon, description: "What it remembers, and its context" },
  { section: "skills", label: "Skills", icon: SparklesIcon, description: "Procedures it follows" },
  { section: "workspace", label: "Workspace", icon: FolderIcon, description: "Its private folder" },
  {
    section: "execution",
    label: "Commands & browser",
    icon: TerminalIcon,
    description: "Commands and a browser in containers",
  },
  { section: "jobs", label: "Jobs", icon: CalendarClockIcon, description: "Tasks on a schedule" },
];

const SECTIONS = [...WISP_SETTINGS_MAIN, ...WISP_SETTINGS_MORE];

export function wispSettingsSectionLabel(section: WispSettingsSection): string {
  return SECTIONS.find((info) => info.section === section)?.label ?? "Settings";
}

interface WispSettingsSectionProps {
  chat: WispChatView;
  section: WispSettingsSection;
  onChangeWisp: (changes: WispChanges) => Promise<boolean> | void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}

/** One section of a Wisp's settings, filling the space it is given. */
export function WispSettingsSectionContent({ chat, section, onChangeWisp, onOpenSettings }: WispSettingsSectionProps) {
  const id = chat.id;
  switch (section) {
    case "profile":
      return <WispProfileEditor key={id} chat={chat} onChangeWisp={onChangeWisp} />;
    // These two scroll and pad themselves.
    case "model":
      return <WispModelSettings conversationId={id} />;
    case "access":
      return <WispPluginSettings conversationId={id} onOpenSettings={onOpenSettings} />;
    default:
      return (
        <div className="wisp-settings-scroll min-h-0 flex-1 overflow-y-auto p-3.5 text-sm">
          {section === "usage" ? <WispSessionReportSection chatId={id} onOpenSettings={onOpenSettings} /> : null}
          {section === "memory" ? (
            <div className="flex flex-col gap-6">
              <WispMemorySettings conversationId={id} />
              <div className="border-t border-border pt-4">
                <WispContextSettings conversationId={id} />
              </div>
            </div>
          ) : null}
          {section === "skills" ? <WispSkillSettings conversationId={id} /> : null}
          {section === "workspace" ? (
            <WispWorkspaceSettings conversationId={id} onOpenSettings={onOpenSettings} />
          ) : null}
          {section === "execution" ? <WispExecutionSettings conversationId={id} /> : null}
          {section === "jobs" ? <WispJobSettings conversationId={id} onOpenSettings={onOpenSettings} /> : null}
        </div>
      );
  }
}

type ProfileDraft = Omit<WispSettingsDraft, "notifyOnUpdatesEnabled">;

function draftOf(chat: WispChatView): ProfileDraft {
  const { id: _id, ...wisp } = chat.wisp;
  return wisp;
}

/** The Wisp's appearance, name, role, and soul, saved together. */
function WispProfileEditor({
  chat,
  onChangeWisp,
}: {
  chat: WispChatView;
  onChangeWisp: (changes: WispChanges) => Promise<boolean> | void;
}) {
  const [draft, setDraft] = useState(() => draftOf(chat));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { wisp } = chat;
  const changed =
    draft.name !== wisp.name ||
    draft.role !== wisp.role ||
    draft.soul !== wisp.soul ||
    draft.color !== wisp.color ||
    !sameWispAppearance(draft.appearance, wisp.appearance);

  async function save() {
    if (!changed || saving) return;
    const name = draft.name.trim() || "Untitled";
    setSaving(true);
    setError("");
    try {
      const saved = await onChangeWisp({
        name,
        role: draft.role,
        soul: draft.soul,
        color: draft.color,
        appearance: draft.appearance,
      });
      if (saved === false) setError("Could not save the profile.");
      else setDraft((current) => ({ ...current, name }));
    } catch {
      setError("Could not save the profile.");
    } finally {
      setSaving(false);
    }
  }

  const settings = { ...draft, notifyOnUpdatesEnabled: chat.notifyOnUpdatesEnabled };
  const change = (changes: Partial<WispSettingsDraft>) => setDraft((current) => ({ ...current, ...changes }));
  return (
    <form
      className="wisp-profile-editor flex min-h-0 flex-1 flex-col"
      aria-label={`Edit ${wisp.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div className="wisp-settings-scroll min-h-0 flex-1 overflow-y-auto p-3.5">
        <WispIdentityFields settings={settings} onChange={change} />
        <WispSoulField soul={draft.soul} onChange={(soul) => change({ soul })} />
      </div>
      {changed || error ? (
        <footer className="flex flex-none flex-col gap-3 border-t border-border p-3.5">
          <FormStatus error={error} />
          <div className="flex items-center gap-2">
            <span className="wisp-profile-editor-dirty mr-auto text-xs text-warning">Unsaved changes</span>
            <Button
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
            <Button type="submit" disabled={saving || !changed} aria-keyshortcuts="Control+S">
              {saving ? "Saving…" : "Save"}
              <kbd className="wisp-kbd" aria-hidden="true">
                Ctrl S
              </kbd>
            </Button>
          </div>
        </footer>
      ) : null}
    </form>
  );
}
