import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleIcon,
  PencilIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";

import type { WispChatView } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import type { WispState } from "@/components/wisp";
import {
  WISP_SETTINGS_MAIN,
  WISP_SETTINGS_MORE,
  type WispSettingsSection,
  type WispSettingsSectionInfo,
} from "@/components/wisp-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useJobs } from "@/hooks/use-jobs";
import { cn } from "@/lib/utils";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import { serializeWispTemplate } from "@/lib/wisp-template";

interface WispProfileProps {
  chat: WispChatView;
  state: WispState;
  onOpenSection: (section: WispSettingsSection) => void;
  onChangeNotifications: (notifyOnUpdatesEnabled: boolean) => void;
  onDelete: () => void;
}

/** The soul as plain text: its paragraphs without headings or Markdown marks. */
export function soulText(soul: string): string {
  return soul
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("#") && !part.startsWith("---"))
    .map((part) =>
      part
        .replace(/[*_`>#]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join("\n\n");
}

/** The model the Wisp runs on, once it is known. */
function useModelName(conversationId: string): string | null {
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.wisp
      .getConversationModel({ conversationId })
      .then((result) => {
        if (!cancelled && result.ok) setModel(result.value.effective?.modelId ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  return model;
}

/** What a profile row says is set, where it is cheap to know. */
function useSectionValues(chat: WispChatView): Partial<Record<WispSettingsSection, string>> {
  const model = useModelName(chat.id);
  const jobs = useJobs().jobs.filter((job) => job.conversationId === chat.id);
  return {
    model: model ?? undefined,
    jobs: jobs.length ? `${jobs.length} scheduled` : undefined,
  };
}

function ShareTemplateButton({ chat, className }: { chat: WispChatView; className?: string }) {
  const copyFeedback = useCopyFeedback(chat.id);
  async function share(): Promise<void> {
    const model = await window.wisp.getConversationModel({ conversationId: chat.id }).catch(() => null);
    await copyFeedback.copy(serializeWispTemplate(chat.wisp, model?.ok ? model.value.effective : null));
  }
  return (
    <>
      <span
        className="sr-only"
        role={copyFeedback.status === "error" ? "alert" : "status"}
        aria-live={copyFeedback.status === "error" ? "assertive" : "polite"}
      >
        {copyFeedback.message}
      </span>
      <button type="button" className={className} onClick={() => void share()}>
        {copyFeedback.status === "success" ? <CheckIcon aria-hidden="true" /> : <Share2Icon aria-hidden="true" />}
        <span className="flex-1">
          {copyFeedback.status === "copying"
            ? "Copying template…"
            : copyFeedback.status === "success"
              ? "Template copied"
              : copyFeedback.status === "error"
                ? "Could not copy template"
                : "Share as template"}
        </span>
      </button>
    </>
  );
}

function DeleteWispButton({
  chat,
  className,
  onDelete,
}: {
  chat: WispChatView;
  className?: string;
  onDelete: () => void;
}) {
  const name = chat.wisp.name;
  return (
    <Dialog>
      <DialogTrigger render={<button type="button" className={className} />}>
        <Trash2Icon aria-hidden="true" />
        <span className="flex-1">Delete {name}…</span>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes this Wisp, including its conversation history and settings. This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <DialogClose render={<Button variant="destructive" type="button" onClick={onDelete} />}>
            Confirm deletion
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who a Wisp is, on a phone: its picture, soul, and the pages of its settings. */
export function WispProfile({
  chat,
  state,
  onBack,
  onOpenSection,
  onChangeNotifications,
  onDelete,
}: WispProfileProps & { onBack: () => void }) {
  const { wisp } = chat;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const values = useSectionValues(chat);
  const soul = soulText(wisp.soul);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const sectionRow = (info: WispSettingsSectionInfo) => (
    <li key={info.section}>
      <button type="button" onClick={() => onOpenSection(info.section)}>
        <info.icon aria-hidden="true" />
        <span>
          {info.label}
          <small>{values[info.section] ?? info.description}</small>
        </span>
        <ChevronRightIcon aria-hidden="true" className="wisp-profile-chevron" />
      </button>
    </li>
  );

  return (
    <section
      className="wisp-profile"
      aria-labelledby="wisp-profile-name"
      style={wispAccentStyle(wispColor(wisp.name, wisp.color))}
    >
      <div className="wisp-profile-hero">
        <div className="wisp-profile-bar">
          <Button variant="ghost" size="icon" type="button" aria-label="Back to conversation" onClick={onBack}>
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
        </div>
        <div className="wisp-profile-picture">
          <WispAvatar wisp={wisp} size="xl" state={state} />
        </div>
        <h1 id="wisp-profile-name" ref={titleRef} tabIndex={-1}>
          {wisp.name}
        </h1>
        {wisp.role ? <p className="wisp-profile-role">{wisp.role}</p> : null}
        <div className="wisp-profile-actions">
          <button type="button" onClick={onBack}>
            <MessageCircleIcon aria-hidden="true" />
            Chat
          </button>
          {WISP_SETTINGS_MAIN.map((info) => (
            <button key={info.section} type="button" onClick={() => onOpenSection(info.section)}>
              {info.section === "profile" ? <PencilIcon aria-hidden="true" /> : <info.icon aria-hidden="true" />}
              {info.section === "profile" ? "Edit" : info.label}
            </button>
          ))}
        </div>
      </div>

      <div className="wisp-profile-body">
        <section className="wisp-profile-card" aria-label="Soul">
          <h2>Soul</h2>
          {soul ? (
            <p className="wisp-profile-soul">{soul}</p>
          ) : (
            <p className="wisp-profile-empty">No soul yet. Tap Edit to describe who {wisp.name} is and how it works.</p>
          )}
        </section>

        <div className="wisp-profile-card wisp-profile-toggle">
          <span>
            Notifications
            <small>Replies and questions</small>
          </span>
          <ToggleSwitch
            checked={chat.notifyOnUpdatesEnabled}
            label="Notifications"
            onChange={() => onChangeNotifications(!chat.notifyOnUpdatesEnabled)}
          />
        </div>

        <section className="wisp-profile-card" aria-labelledby="wisp-profile-more">
          <h2 id="wisp-profile-more">What {wisp.name} knows and does</h2>
          <ul className="wisp-profile-list">{WISP_SETTINGS_MORE.map(sectionRow)}</ul>
        </section>

        <div className="wisp-profile-end">
          <ShareTemplateButton chat={chat} className="wisp-profile-end-button" />
          <DeleteWispButton chat={chat} className="wisp-profile-end-button" onDelete={onDelete} />
        </div>
      </div>
    </section>
  );
}

function PanelRow({
  icon: Icon,
  label,
  value,
  shortcut,
  onClick,
}: {
  icon: WispSettingsSectionInfo["icon"];
  label: string;
  value?: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="wisp-panel-row" onClick={onClick} aria-keyshortcuts={shortcut}>
      <Icon aria-hidden="true" />
      <span className="wisp-panel-row-label">{label}</span>
      {value ? <span className="wisp-panel-row-value">{value}</span> : null}
      {shortcut ? <kbd className="wisp-kbd">{shortcut}</kbd> : null}
    </button>
  );
}

function PanelMenu({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="wisp-panel-menu" role={label ? "group" : undefined} aria-label={label}>
      {label ? <p className="wisp-panel-menu-label">{label}</p> : null}
      {children}
    </div>
  );
}

/** Who a Wisp is, in the desktop's side panel: compact, a list of rows that say what is set. */
export function WispProfilePanel({ chat, state, onOpenSection, onChangeNotifications, onDelete }: WispProfileProps) {
  const { wisp } = chat;
  const values = useSectionValues(chat);
  const soul = soulText(wisp.soul);
  return (
    <section
      className="wisp-profile-panel"
      aria-labelledby="wisp-profile-name"
      style={wispAccentStyle(wispColor(wisp.name, wisp.color))}
      onKeyDown={(event) => {
        // E edits the profile, unless the key is typed into something.
        const target = event.target as HTMLElement;
        if (event.key.toLowerCase() !== "e" || event.ctrlKey || event.metaKey || event.altKey) return;
        if (target.closest("input, textarea, [contenteditable=true]")) return;
        event.preventDefault();
        onOpenSection("profile");
      }}
    >
      <div className="wisp-profile-panel-id">
        <span className="wisp-profile-picture">
          <WispAvatar wisp={wisp} size="lg" state={state} />
        </span>
        <div className="min-w-0">
          <h1 id="wisp-profile-name">{wisp.name}</h1>
          {wisp.role ? <p className="wisp-profile-role">{wisp.role}</p> : null}
        </div>
      </div>
      {soul ? (
        <p className="wisp-profile-panel-soul">{soul}</p>
      ) : (
        <p className="wisp-profile-panel-soul wisp-profile-empty">No soul yet.</p>
      )}
      <PanelMenu>
        {WISP_SETTINGS_MAIN.map((info) => (
          <PanelRow
            key={info.section}
            icon={info.section === "profile" ? PencilIcon : info.icon}
            label={info.section === "profile" ? "Edit profile" : info.label}
            value={values[info.section]}
            shortcut={info.section === "profile" ? "E" : undefined}
            onClick={() => onOpenSection(info.section)}
          />
        ))}
      </PanelMenu>
      <PanelMenu label={`What ${wisp.name} knows and does`}>
        {WISP_SETTINGS_MORE.map((info) => (
          <PanelRow
            key={info.section}
            icon={info.icon}
            label={info.label}
            value={values[info.section]}
            onClick={() => onOpenSection(info.section)}
          />
        ))}
      </PanelMenu>
      <PanelMenu>
        <div className="wisp-panel-row wisp-panel-toggle">
          <span className="wisp-panel-row-label">Notifications</span>
          <ToggleSwitch
            checked={chat.notifyOnUpdatesEnabled}
            label="Notifications"
            onChange={() => onChangeNotifications(!chat.notifyOnUpdatesEnabled)}
          />
        </div>
      </PanelMenu>
      <PanelMenu>
        <ShareTemplateButton chat={chat} className="wisp-panel-row" />
        <DeleteWispButton chat={chat} className={cn("wisp-panel-row", "wisp-panel-row-danger")} onDelete={onDelete} />
      </PanelMenu>
    </section>
  );
}
