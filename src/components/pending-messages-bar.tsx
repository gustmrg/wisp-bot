import { CalendarClockIcon, HourglassIcon, PaperclipIcon, PencilIcon, SendIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import { AttachmentChips } from "@/components/attachment-chips";
import { ScheduleSendPicker } from "@/components/schedule-send-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageQueueController } from "@/hooks/use-message-queue";
import type { ScheduledMessagesController } from "@/hooks/use-scheduled-messages";
import { useTimeZone } from "@/hooks/use-time-zone";
import { formatScheduledTime } from "@/lib/scheduled-time";
import type { QueuedMessage } from "../../shared/message-queue";
import type { ScheduledMessage } from "../../shared/scheduled-messages";
import { messagePreview, messageWithAttachments, splitMessageAttachments } from "../../shared/workspace";

interface PendingMessagesBarProps {
  /** Messages waiting for the Wisp to be free, next first. */
  queued: ReadonlyArray<QueuedMessage>;
  /** Messages scheduled for later, soonest first. */
  scheduled: ReadonlyArray<ScheduledMessage>;
  queue: Pick<MessageQueueController, "update" | "cancel">;
  schedule: Pick<ScheduledMessagesController, "update" | "cancel" | "sendNow">;
}

type Editing = { kind: "queued"; message: QueuedMessage } | { kind: "scheduled"; message: ScheduledMessage };

/**
 * What a Wisp has yet to read, above the composer: messages waiting for it to
 * be free, then messages scheduled for later. Each can be changed or dropped
 * until the Wisp takes it.
 */
export function PendingMessagesBar({ queued, scheduled, queue, schedule }: PendingMessagesBarProps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const timeZone = useTimeZone();
  if (!queued.length && !scheduled.length) return null;
  const now = new Date();

  async function act(id: string, action: () => Promise<string | null>): Promise<void> {
    setBusyId(id);
    setError("");
    const failure = await action();
    setBusyId(null);
    if (failure) setError(failure);
  }

  return (
    <section className="mx-auto mb-1.5 w-full max-w-[1400px]" aria-label="Pending messages">
      <ul className="flex max-h-[104px] flex-col gap-1 overflow-y-auto">
        {queued.map((message, index) => (
          <PendingRow
            key={message.id}
            icon={<HourglassIcon aria-hidden="true" />}
            label={index === 0 ? "Next" : "Queued"}
            note={message.scheduled ? "Scheduled" : undefined}
            text={message.text}
          >
            <BarAction
              label="Edit queued message"
              disabled={busyId === message.id}
              onClick={() => setEditing({ kind: "queued", message })}
            >
              <PencilIcon aria-hidden="true" />
            </BarAction>
            <BarAction
              label="Remove from queue"
              disabled={busyId === message.id}
              onClick={() => void act(message.id, () => queue.cancel(message.id))}
            >
              <XIcon aria-hidden="true" />
            </BarAction>
          </PendingRow>
        ))}
        {scheduled.map((message) => (
          <PendingRow
            key={message.id}
            icon={<CalendarClockIcon aria-hidden="true" />}
            label={formatScheduledTime(new Date(message.nextRunAt), now, timeZone)}
            text={message.text}
          >
            <BarAction
              label="Edit scheduled message"
              disabled={busyId === message.id}
              onClick={() => setEditing({ kind: "scheduled", message })}
            >
              <PencilIcon aria-hidden="true" />
            </BarAction>
            <BarAction
              label="Send now"
              disabled={busyId === message.id}
              onClick={() => void act(message.id, () => schedule.sendNow(message.id))}
            >
              <SendIcon aria-hidden="true" />
            </BarAction>
            <BarAction
              label="Cancel scheduled message"
              disabled={busyId === message.id}
              onClick={() => void act(message.id, () => schedule.cancel(message.id))}
            >
              <XIcon aria-hidden="true" />
            </BarAction>
          </PendingRow>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-1 pl-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {editing?.kind === "queued" ? (
        <EditMessageDialog
          title="Edit queued message"
          description="The Wisp reads it when it finishes what it is doing."
          text={editing.message.text}
          onClose={() => setEditing(null)}
          onSave={(text) => queue.update(editing.message.id, text)}
        />
      ) : editing?.kind === "scheduled" ? (
        <EditMessageDialog
          title="Edit scheduled message"
          description="Sent to the Wisp at the time you choose."
          text={editing.message.text}
          at={new Date(editing.message.nextRunAt)}
          onClose={() => setEditing(null)}
          onSave={(text, at) => schedule.update(editing.message.id, { text, at })}
        />
      ) : null}
    </section>
  );
}

function PendingRow({
  icon,
  label,
  note,
  text,
  children,
}: {
  icon: ReactNode;
  label: string;
  note?: string;
  text: string;
  children: ReactNode;
}) {
  const { text: typed, attachments } = splitMessageAttachments(text);
  const files = attachments.map(({ name }) => name).join(", ");
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/60 py-1 pr-1 pl-2 text-xs">
      <span className="flex-none text-dim [&_svg]:size-3.5">{icon}</span>
      <span className="flex-none font-medium">{label}</span>
      {note ? <span className="flex-none text-faint">{note}</span> : null}
      <span className="min-w-0 flex-1 truncate text-dim" title={messagePreview(text)}>
        {messagePreview(text)}
      </span>
      {typed && attachments.length ? (
        <span className="flex flex-none items-center gap-0.5 text-faint [&_svg]:size-3" title={files}>
          <PaperclipIcon aria-hidden="true" />
          {attachments.length}
          <span className="sr-only">{attachments.length === 1 ? " attached file" : " attached files"}</span>
        </span>
      ) : null}
      {children}
    </li>
  );
}

function BarAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-flex flex-none [&>button:disabled]:pointer-events-none"
        delay={300}
      >
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="flex size-6 items-center justify-center rounded-md text-dim enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5"
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Edits a pending message's text, and its send time when it has one. */
function EditMessageDialog({
  title,
  description,
  text: initialText,
  at,
  onClose,
  onSave,
}: {
  title: string;
  description: string;
  text: string;
  at?: Date;
  onClose: () => void;
  onSave: (text: string, at: Date) => Promise<string | null>;
}) {
  // Only the typed text is edited; the attached files are kept as they were.
  const [{ text: typed, attachments }] = useState(() => splitMessageAttachments(initialText));
  const [text, setText] = useState(typed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const empty = !text.trim() && !attachments.length;

  async function save(time: Date): Promise<void> {
    if (empty) return;
    setSaving(true);
    setError("");
    const failure = await onSave(messageWithAttachments(text.trim(), attachments), time);
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Message"
          className="max-h-[240px]"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <AttachmentChips attachments={attachments} />
        {at ? (
          <ScheduleSendPicker
            initial={at}
            submitLabel={saving ? "Saving…" : "Save"}
            busy={saving || empty}
            onPick={(time) => void save(time)}
          />
        ) : (
          <Button size="sm" disabled={saving || empty} onClick={() => void save(new Date())}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
