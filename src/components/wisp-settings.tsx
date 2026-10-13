import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  BarChart3Icon,
  BrainIcon,
  CalendarClockIcon,
  CpuIcon,
  FolderIcon,
  KeyRoundIcon,
  PencilIcon,
  SparklesIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";

import type { WispChanges, WispChatView } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import { WispContextSettings } from "@/components/wisp-context-settings";
import { WispExecutionSettings } from "@/components/wisp-execution-settings";
import { WispJobSettings } from "@/components/wisp-job-settings";
import { WispModelSettings } from "@/components/wisp-model-settings";
import { WispPluginSettings } from "@/components/wisp-plugin-settings";
import { WispSessionReportSection } from "@/components/wisp-session-report";
import { WispIdentityFields, WispSoulField, type WispSettingsDraft } from "@/components/wisp-settings-fields";
import { WispSkillSettings } from "@/components/wisp-skill-settings";
import { WispWorkspaceSettings } from "@/components/wisp-workspace-settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FormStatus } from "@/components/ui/form-status";
import type { IntegrationSettingsTarget } from "@/lib/plugin-access";
import { cn } from "@/lib/utils";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
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
  { section: "memory", label: "Memory", icon: BrainIcon, description: "Context and saved memory" },
  { section: "skills", label: "Skills", icon: SparklesIcon, description: "Procedures it follows" },
  { section: "workspace", label: "Workspace", icon: FolderIcon, description: "Its private folder" },
  { section: "execution", label: "Commands", icon: TerminalIcon, description: "Commands in a container" },
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
          {section === "usage" ? <WispSessionReportSection chatId={id} /> : null}
          {section === "memory" ? <WispContextSettings conversationId={id} /> : null}
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

interface WispSettingsDialogProps {
  chat: WispChatView;
  /** The section shown, or null when the dialog is closed. */
  section: WispSettingsSection | null;
  onSectionChange: (section: WispSettingsSection | null) => void;
  onChangeWisp: (changes: WispChanges) => Promise<boolean> | void;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}

/** On the desktop a Wisp's settings open in a dialog shaped like the app's: sections on the left, one shown. */
export function WispSettingsDialog({
  chat,
  section,
  onSectionChange,
  onChangeWisp,
  onOpenSettings,
}: WispSettingsDialogProps) {
  const navRef = useRef<HTMLElement>(null);
  const { wisp } = chat;
  const shown = section ?? "profile";
  // Sections stay as they were left while the dialog is open, so an unsaved edit survives a look elsewhere.
  const [visited, setVisited] = useState<ReadonlySet<WispSettingsSection>>(new Set());
  if (section && !visited.has(section)) setVisited(new Set([...visited, section]));
  if (!section && visited.size) setVisited(new Set());

  // The arrow keys move between sections, as in a list.
  function moveSelection(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = SECTIONS.findIndex((info) => info.section === shown);
    const next = SECTIONS[(index + (event.key === "ArrowDown" ? 1 : -1) + SECTIONS.length) % SECTIONS.length];
    if (!next) return;
    onSectionChange(next.section);
    navRef.current?.querySelector<HTMLButtonElement>(`[data-section="${next.section}"]`)?.focus();
  }

  const navItem = (info: WispSettingsSectionInfo) => (
    <button
      key={info.section}
      type="button"
      data-section={info.section}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 text-left text-sm text-dim outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-[15px]",
        shown === info.section && "bg-accent text-accent-foreground",
      )}
      aria-current={shown === info.section ? "page" : undefined}
      // Only the shown section is a tab stop, so the dialog opens with focus on it.
      tabIndex={shown === info.section ? 0 : -1}
      onClick={() => onSectionChange(info.section)}
    >
      <info.icon aria-hidden="true" />
      {info.label}
    </button>
  );

  return (
    <Dialog open={section !== null} onOpenChange={(open) => (open ? undefined : onSectionChange(null))}>
      <DialogContent
        className="wisp-settings-dialog grid h-[min(680px,calc(100vh-64px))] w-[min(900px,calc(100vw-32px))] max-w-[900px] grid-cols-[210px_1fr] gap-0 overflow-hidden p-0"
        style={wispAccentStyle(wispColor(wisp.name, wisp.color))}
      >
        <nav
          ref={navRef}
          className="flex min-h-0 flex-col gap-[3px] border-r border-border bg-sidebar px-2.5 py-4"
          aria-label={`${wisp.name} settings sections`}
          onKeyDown={moveSelection}
        >
          <div className="mb-3 flex items-center gap-2.5 px-1.5">
            <span className="wisp-halo">
              <WispAvatar wisp={wisp} size="sm" />
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
              <DialogTitle className="truncate text-base font-semibold">{wisp.name}</DialogTitle>
              <DialogDescription className="text-xs text-dim">Wisp settings</DialogDescription>
            </span>
          </div>
          {WISP_SETTINGS_MAIN.map(navItem)}
          <div className="mx-2 my-1.5 h-px bg-border" />
          {WISP_SETTINGS_MORE.map(navItem)}
          <p className="mt-auto px-1.5 text-2xs text-faint">
            <kbd className="wisp-kbd">↑</kbd>
            <kbd className="wisp-kbd">↓</kbd> move · <kbd className="wisp-kbd">Esc</kbd> close
          </p>
        </nav>
        <section className="flex min-h-0 min-w-0 flex-col" aria-labelledby="wisp-settings-section-title">
          <h2 id="wisp-settings-section-title" className="flex-none px-[26px] pt-5 pb-1 text-lg font-semibold">
            {wispSettingsSectionLabel(shown)}
          </h2>
          {SECTIONS.map(({ section: kept }) =>
            // Access reads the app's connections afresh each time it is shown.
            kept === shown || (visited.has(kept) && kept !== "access") ? (
              <div
                key={kept}
                hidden={kept !== shown}
                className="wisp-settings-dialog-body flex min-h-0 flex-1 flex-col px-3"
              >
                <WispSettingsSectionContent
                  chat={chat}
                  section={kept}
                  onChangeWisp={onChangeWisp}
                  onOpenSettings={onOpenSettings}
                />
              </div>
            ) : null,
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
