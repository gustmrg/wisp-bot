import {
  ArrowUpIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  EyeOffIcon,
  FileIcon,
  LoaderCircleIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { ScheduleSendPicker } from "@/components/schedule-send-picker";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModelVision } from "@/hooks/use-model-image-input";
import { useTimeZone } from "@/hooks/use-time-zone";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import { formatScheduledTime, schedulePresets } from "@/lib/scheduled-time";
import { formatShortcut, matchesShortcut, SCHEDULE_SEND_SHORTCUT } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ChatView } from "@/chat-data";
import { chatName } from "@/lib/chat-schema";
import type { VoiceLanguage, VoiceProviderId } from "../../shared/voice";
import { attachmentsNeedingVision, messageWithAttachments, type WorkspaceAttachment } from "../../shared/workspace";

export interface VoiceInputSettings {
  deviceId: string;
  providerId: VoiceProviderId;
  modelId: string;
  language: VoiceLanguage;
  autoSend: boolean;
  shortcut: string;
}

const DEFAULT_VOICE_SETTINGS: VoiceInputSettings = {
  deviceId: DEFAULT_PREFERENCES.microphone,
  providerId: DEFAULT_PREFERENCES.voiceProvider,
  modelId: DEFAULT_PREFERENCES.voiceModel,
  language: DEFAULT_PREFERENCES.voiceLanguage,
  autoSend: DEFAULT_PREFERENCES.voiceAutoSend,
  shortcut: DEFAULT_PREFERENCES.shortcuts.voiceInput,
};

export interface ChatComposerProps {
  autoFocus?: boolean;
  enterToSend?: boolean;
  /** The phone layout: voice input takes the send button's place while there is nothing to send. */
  mobile?: boolean;
  chat: ChatView;
  status: ManagedConversationStatus;
  error?: string;
  acknowledging: boolean;
  onConfigure?: () => void;
  voice?: VoiceInputSettings;
  /** Listen for the voice input shortcut; off while the composer is not on screen. */
  voiceShortcutEnabled?: boolean;
  onConfigureVoice?: () => void;
  onAbort: () => void;
  onSend: (text: string) => void;
  /** Schedules the draft instead of sending it; resolves with an error message, or null. Absent when unavailable. */
  onSchedule?: (text: string, at: Date) => Promise<string | null>;
}

export function ChatComposer({
  autoFocus = true,
  enterToSend = true,
  mobile = false,
  chat,
  status,
  error,
  acknowledging,
  onConfigure,
  voice = DEFAULT_VOICE_SETTINGS,
  voiceShortcutEnabled = true,
  onConfigureVoice,
  onAbort,
  onSend,
  onSchedule,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<WorkspaceAttachment>>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"actions" | "schedule">("actions");
  // A time picked from the + menu waits on the draft; from the send button's menu or the shortcut it schedules now.
  const [pickMode, setPickMode] = useState<"draft" | "now">("draft");
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  // A long press opens the send button's menu; the tap that ends it must not also send.
  const sendMenuOpen = useRef(false);
  const timeZone = useTimeZone();
  // Attaching picks files on this computer, so a server elsewhere cannot use them.
  const working = status === "working";
  const needsConfiguration = status === "configuration_required";
  const canSend = (status === "idle" || working) && !acknowledging && chat.kind === "wisp";
  const vision = useModelVision(chat.kind === "wisp" ? chat.id : null);
  const visionHint = vision.imageInput === false ? missingVisionHint(attachments, vision.imageModel) : null;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the transcript goes: the text selected when recording started.
  const insertAt = useRef<readonly [number, number] | null>(null);
  const latest = useRef({ draft, attachments, canSend, autoSend: voice.autoSend });
  latest.current = { draft, attachments, canSend, autoSend: voice.autoSend };
  const voiceInput = useVoiceInput({
    deviceId: voice.deviceId,
    providerId: voice.providerId,
    modelId: voice.modelId,
    language: voice.language,
    onTranscript: insertTranscript,
  });
  const voiceBusy = voiceInput.phase !== "idle";
  const recording = voiceInput.phase === "recording";
  const transcribing = voiceInput.phase === "transcribing";
  const voiceAvailable = chat.kind === "wisp";
  const shortcutLabel = formatShortcut(voice.shortcut);
  const voiceDisabled =
    !voiceAvailable ||
    transcribing ||
    voiceInput.phase === "starting" ||
    (!recording && !!voiceInput.unavailableReason);
  const voiceHint =
    (!recording && voiceInput.unavailableReason) ||
    `${recording ? "Stop recording" : "Voice input"} (${shortcutLabel})`;

  function submit(text: string, files: ReadonlyArray<WorkspaceAttachment>): void {
    setDraft("");
    setAttachments([]);
    setAttachError("");
    onSend(messageWithAttachments(text, files));
  }

  const hasDraft = Boolean(draft.trim() || attachments.length);
  // Scheduling only stores the message, so a busy or unconfigured Wisp can still take one.
  const schedulable = Boolean(onSchedule) && chat.kind === "wisp";
  const canPickTime = schedulable && !voiceBusy && !scheduling;
  const canSchedule = canPickTime && hasDraft;
  const scheduleShortcutLabel = formatShortcut(SCHEDULE_SEND_SHORTCUT);

  async function schedule(at: Date): Promise<void> {
    if (!onSchedule || !canSchedule) return;
    const text = messageWithAttachments(draft.trim(), attachments);
    setScheduling(true);
    setScheduleError("");
    const failure = await onSchedule(text, at);
    setScheduling(false);
    if (failure) {
      setScheduleError(failure);
      return;
    }
    setMenuOpen(false);
    setScheduledAt(null);
    setDraft("");
    setAttachments([]);
    setAttachError("");
    textareaRef.current?.focus();
  }

  function openSchedulePicker(mode: "draft" | "now"): void {
    setPickMode(mode);
    setMenuView("schedule");
    setScheduleError("");
    setMenuOpen(true);
  }

  function pickTime(at: Date): void {
    if (pickMode === "now") {
      void schedule(at);
      return;
    }
    setScheduledAt(at);
    setMenuOpen(false);
    textareaRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (sendMenuOpen.current) return;
    if (scheduledAt) {
      void schedule(scheduledAt);
      return;
    }
    const text = draft.trim();
    if ((!text && !attachments.length) || !canSend || voiceBusy) return;
    submit(text, attachments);
  }

  function insertTranscript(text: string): void {
    const current = latest.current;
    const [start, end] = insertAt.current ?? [current.draft.length, current.draft.length];
    const before = current.draft.slice(0, start);
    const after = current.draft.slice(end);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    const next = `${before}${lead}${text}${trail}${after}`;
    if (current.autoSend && current.canSend) {
      submit(next.trim(), current.attachments);
      return;
    }
    setDraft(next);
    const cursor = before.length + lead.length + text.length;
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  function toggleVoiceInput(): void {
    if (!voiceAvailable || (voiceInput.phase === "idle" && voiceInput.unavailableReason)) return;
    if (voiceInput.phase === "idle") {
      const textarea = textareaRef.current;
      insertAt.current = textarea ? [textarea.selectionStart, textarea.selectionEnd] : null;
    }
    voiceInput.toggle();
  }

  const toggleRef = useRef(toggleVoiceInput);
  toggleRef.current = toggleVoiceInput;
  const phaseRef = useRef(voiceInput.phase);
  phaseRef.current = voiceInput.phase;
  const { cancel: cancelVoiceInput } = voiceInput;
  useEffect(() => {
    if (!voiceShortcutEnabled || !voiceAvailable) return;
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      // Settings and other dialogs keep their own keys, including the shortcut recorder.
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("[role='dialog']"))) {
        return;
      }
      if (matchesShortcut(event, voice.shortcut)) {
        event.preventDefault();
        if (!event.repeat) toggleRef.current();
      } else if (event.key === "Escape" && phaseRef.current !== "idle") {
        event.preventDefault();
        cancelVoiceInput();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [voiceShortcutEnabled, voiceAvailable, voice.shortcut, cancelVoiceInput]);

  async function attachFiles(): Promise<void> {
    setAttaching(true);
    setAttachError("");
    try {
      const result = await window.wisp.attachWorkspaceFiles({ conversationId: chat.id });
      if (!result.ok) {
        setAttachError(result.error.message);
        return;
      }
      const added = result.value.files;
      setAttachments((current) => [...current, ...added.filter((file) => !current.some((c) => c.path === file.path))]);
    } catch {
      setAttachError("Could not attach files.");
    } finally {
      setAttaching(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (matchesShortcut(event, SCHEDULE_SEND_SHORTCUT)) {
      event.preventDefault();
      if (canSchedule) openSchedulePicker("now");
      return;
    }
    if (enterToSend && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  // One button carries the main action and changes with the composer's state.
  const primary: PrimaryAction = recording
    ? "recording"
    : scheduledAt
      ? "schedule"
      : hasDraft
        ? "send"
        : working
          ? "stop"
          : mobile
            ? "voice"
            : "send";
  const showInlineStop = working && primary !== "stop" && !recording;
  // On a phone the microphone moves into the field once there is text, and leaves it to the stop button.
  const showInlineVoice = !recording && primary !== "voice" && (!mobile || (hasDraft && !working));
  const sendLabel = working ? "Queue message" : "Send message";
  const now = new Date();

  function voiceButton(className: string, variant?: PrimaryAction) {
    return (
      <ComposerTooltip message={voiceHint}>
        <button
          type="button"
          className={className}
          data-variant={variant}
          aria-label={transcribing ? "Transcribing" : "Start voice input"}
          aria-keyshortcuts={voice.shortcut.replaceAll("Ctrl", "Control").replace(/Key([A-Z])$/, "$1")}
          disabled={voiceDisabled}
          onClick={toggleVoiceInput}
        >
          {transcribing ? (
            <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
          ) : (
            <MicIcon aria-hidden="true" />
          )}
        </button>
      </ComposerTooltip>
    );
  }

  function primaryButton() {
    if (primary === "voice") return voiceButton(PRIMARY_BUTTON, primary);
    if (primary === "recording") {
      return (
        <ComposerTooltip message={voiceHint}>
          <button
            type="button"
            className={cn(PRIMARY_BUTTON, "bg-destructive text-white")}
            data-variant={primary}
            aria-label="Stop recording and transcribe"
            onClick={toggleVoiceInput}
          >
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </button>
        </ComposerTooltip>
      );
    }
    if (primary === "stop") {
      return (
        <ComposerTooltip message="Stop response">
          <button
            type="button"
            className={PRIMARY_BUTTON}
            data-variant={primary}
            aria-label="Stop response"
            onClick={onAbort}
          >
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </button>
        </ComposerTooltip>
      );
    }
    if (primary === "schedule" && scheduledAt) {
      return (
        <ComposerTooltip message={`Schedule for ${formatScheduledTime(scheduledAt, now, timeZone)}`}>
          <button
            type="submit"
            className={cn(PRIMARY_BUTTON, "bg-blue text-white")}
            data-variant={primary}
            aria-label="Schedule message"
            disabled={!canSchedule}
          >
            <CalendarClockIcon aria-hidden="true" />
          </button>
        </ComposerTooltip>
      );
    }
    const send = (
      <ComposerTooltip
        message={`${sendLabel}${enterToSend ? " (Enter)" : ""}${canSchedule ? ". Right-click to schedule" : ""}`}
      >
        <button
          type="submit"
          className={PRIMARY_BUTTON}
          data-variant="send"
          aria-label={sendLabel}
          disabled={!hasDraft || !canSend || voiceBusy}
        >
          <ArrowUpIcon aria-hidden="true" />
        </button>
      </ComposerTooltip>
    );
    if (!canSchedule) return send;
    // A long press or a right click on the send button offers the same times as the picker.
    return (
      <ContextMenu
        onOpenChange={(open) => {
          sendMenuOpen.current = open;
        }}
      >
        <ContextMenuTrigger
          render={<span className="inline-flex flex-none" />}
          onTouchEnd={(event) => {
            // Lifting the finger after a long press would click outside the menu that just opened and close it.
            if (sendMenuOpen.current) event.preventDefault();
          }}
        >
          {send}
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Schedule send">
          <div className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-dim">Schedule send</div>
          {schedulePresets(now, timeZone).map((preset) => (
            <ContextMenuItem key={preset.label} onClick={() => void schedule(preset.at)}>
              <CalendarClockIcon aria-hidden="true" />
              <span className="flex-1">{preset.label}</span>
              <span className="text-xs text-dim">{formatScheduledTime(preset.at, now, timeZone)}</span>
            </ContextMenuItem>
          ))}
          <ContextMenuItem onClick={() => openSchedulePicker("now")}>
            <CalendarClockIcon aria-hidden="true" />
            Other time…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  function leadButton() {
    if (recording) {
      return (
        <ComposerTooltip message="Cancel recording (Esc)">
          <button type="button" className={LEAD_BUTTON} aria-label="Cancel recording" onClick={cancelVoiceInput}>
            <XIcon aria-hidden="true" />
          </button>
        </ComposerTooltip>
      );
    }
    if (chat.kind !== "wisp") return null;
    if (!schedulable) {
      return (
        <ComposerTooltip message={attaching ? "Copying files to the workspace…" : "Attach files"}>
          <button
            type="button"
            className={LEAD_BUTTON}
            aria-label="Attach files"
            disabled={attaching}
            onClick={() => void attachFiles()}
          >
            <PaperclipIcon aria-hidden="true" />
          </button>
        </ComposerTooltip>
      );
    }
    return (
      <Popover
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) setMenuView("actions");
          setMenuOpen(open);
          if (!open) setScheduleError("");
        }}
      >
        <ComposerTooltip message={`Attach files or schedule (${scheduleShortcutLabel})`}>
          <PopoverTrigger type="button" className={LEAD_BUTTON} aria-label="Attach or schedule">
            <PlusIcon aria-hidden="true" />
          </PopoverTrigger>
        </ComposerTooltip>
        <PopoverContent align="start" className={menuView === "actions" ? "w-56 p-1" : undefined}>
          {menuView === "actions" ? (
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                className={MENU_ROW}
                disabled={attaching}
                onClick={() => {
                  setMenuOpen(false);
                  void attachFiles();
                }}
              >
                <PaperclipIcon aria-hidden="true" />
                Attach files
              </button>
              <button
                type="button"
                className={MENU_ROW}
                disabled={!canPickTime}
                onClick={() => openSchedulePicker("draft")}
              >
                <CalendarClockIcon aria-hidden="true" />
                Schedule send
              </button>
            </div>
          ) : (
            <>
              <PopoverTitle>Schedule send</PopoverTitle>
              <ScheduleSendPicker
                submitLabel={pickMode === "draft" ? "Set time" : "Schedule"}
                busy={scheduling}
                onPick={pickTime}
              />
              {scheduleError ? (
                <p role="alert" className="px-2 pt-1.5 text-xs text-destructive">
                  {scheduleError}
                </p>
              ) : null}
            </>
          )}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <form className="chat-composer flex-none px-3 pb-3" onSubmit={handleSubmit}>
      <div className="pl-2.5 text-xs text-dim not-empty:pb-2" role="status">
        {chat.kind === "circle" ? (
          "Circle conversations are not enabled yet"
        ) : needsConfiguration ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>Choose a provider and model before sending a message.</span>
            {onConfigure ? (
              <ComposerTooltip message="Configure AI model">
                <button
                  type="button"
                  className="font-medium text-primary underline underline-offset-2"
                  onClick={onConfigure}
                >
                  Configure AI model
                </button>
              </ComposerTooltip>
            ) : null}
          </div>
        ) : voiceInput.error ? (
          <ComposerError message={voiceInput.error.message}>
            {voiceInput.error.needsSetup && onConfigureVoice ? (
              <ComposerTooltip message="Set up voice input">
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={onConfigureVoice}
                >
                  Set up voice input
                </button>
              </ComposerTooltip>
            ) : null}
          </ComposerError>
        ) : recording ? (
          `Recording… Press ${shortcutLabel} or the stop button to transcribe, Esc to cancel.`
        ) : transcribing ? (
          "Transcribing…"
        ) : voiceInput.phase === "starting" ? (
          "Starting the microphone…"
        ) : scheduleError || attachError || error ? (
          <ComposerError message={scheduleError || attachError || error || ""} />
        ) : attaching ? (
          "Copying files to the workspace…"
        ) : visionHint ? (
          <span className="flex items-start gap-1.5 text-warning">
            <EyeOffIcon aria-hidden="true" className="mt-px size-3.5 flex-none" />
            <span>{visionHint}</span>
          </span>
        ) : acknowledging ? (
          "Queueing your message…"
        ) : null}
      </div>
      <div
        className={cn(
          "composer-box mx-auto w-full max-w-[1400px] rounded-2xl border border-border bg-muted p-1.5 transition-[border-color] duration-[120ms] focus-within:border-ring",
          recording && "border-destructive/60 focus-within:border-destructive/60",
        )}
        data-recording={recording || undefined}
      >
        <div className="composer-input flex items-end gap-1">
          {leadButton()}
          <div className="composer-field flex min-w-0 flex-1 flex-col">
            {scheduledAt || attachments.length ? (
              <div className="composer-chips flex flex-wrap gap-1.5 px-1 pt-0.5 pb-1">
                {scheduledAt ? (
                  <span className="flex h-6 items-center gap-1.5 rounded-full bg-blue/15 pr-0.5 pl-2 text-xs font-medium text-blue [&_svg]:size-3.5">
                    <CalendarClockIcon aria-hidden="true" />
                    {formatScheduledTime(scheduledAt, now, timeZone)}
                    <ComposerTooltip message="Send normally instead">
                      <button
                        type="button"
                        className="flex size-5 flex-none items-center justify-center rounded-full hover:bg-blue/15 [&_svg]:size-3"
                        aria-label="Remove the scheduled time"
                        onClick={() => setScheduledAt(null)}
                      >
                        <XIcon aria-hidden="true" />
                      </button>
                    </ComposerTooltip>
                  </span>
                ) : null}
                {attachments.length ? (
                  <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Attached files">
                    {attachments.map((file) => (
                      <li
                        key={file.path}
                        className="flex max-w-[240px] items-center gap-1 rounded-md border border-border bg-background py-0.5 pl-1.5 pr-0.5 text-xs [&_svg]:size-3"
                      >
                        <FileIcon aria-hidden="true" className="flex-none text-dim" />
                        <span className="truncate" title={file.path}>
                          {file.name}
                        </span>
                        <ComposerTooltip message={`Remove ${file.name} from this message`}>
                          <button
                            type="button"
                            className="flex size-4 flex-none items-center justify-center rounded text-dim hover:bg-accent hover:text-foreground"
                            aria-label={`Remove ${file.name} from this message`}
                            onClick={() =>
                              setAttachments((current) => current.filter((item) => item.path !== file.path))
                            }
                          >
                            <XIcon aria-hidden="true" />
                          </button>
                        </ComposerTooltip>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="flex min-w-0 items-end">
              {recording ? <RecordingMeter levels={voiceInput.levels} elapsed={voiceInput.elapsed} /> : null}
              <textarea
                ref={textareaRef}
                hidden={recording}
                autoFocus={autoFocus}
                rows={1}
                className="max-h-[200px] min-h-7 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1.5 py-1 text-foreground outline-none leading-5 placeholder:text-dim field-sizing-content"
                aria-label={`Message ${chatName(chat)}`}
                placeholder={transcribing ? "Transcribing…" : mobile ? "Message" : `Message ${chatName(chat)}`}
                value={draft}
                disabled={chat.kind === "circle"}
                readOnly={transcribing}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
              />
              {showInlineStop ? (
                <ComposerTooltip message="Stop response">
                  <button type="button" className={INLINE_BUTTON} aria-label="Stop response" onClick={onAbort}>
                    <SquareIcon aria-hidden="true" fill="currentColor" className="size-3! text-foreground" />
                  </button>
                </ComposerTooltip>
              ) : null}
              {showInlineVoice ? voiceButton(INLINE_BUTTON) : null}
            </div>
          </div>
          {primaryButton()}
        </div>
      </div>
    </form>
  );
}

type PrimaryAction = "send" | "schedule" | "stop" | "voice" | "recording";

const LEAD_BUTTON =
  "composer-lead flex size-7 flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-[0.35] [&_svg]:size-4";
const INLINE_BUTTON =
  "composer-inline flex size-7 flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-[0.35] [&_svg]:size-4";
const PRIMARY_BUTTON =
  "composer-primary flex size-7 flex-none select-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground [-webkit-touch-callout:none] enabled:hover:opacity-[0.85] disabled:opacity-[0.35] [&_svg]:size-3.5 data-[variant=recording]:[&_svg]:size-3 data-[variant=stop]:[&_svg]:size-3";
const MENU_ROW =
  "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-50 [&_svg]:size-4 [&_svg]:flex-none [&_svg]:text-dim";

function ComposerTooltip({ message, children }: { message: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-flex flex-none [&>button:disabled]:pointer-events-none"
        delay={300}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const METER_BAR_PITCH_PX = 6;
const FALLBACK_METER_BARS = 24;

/** How many meter bars fit across the element, following its size as the window changes. */
function useBarCount() {
  const ref = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState(FALLBACK_METER_BARS);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      // A bar is 3px with a 3px gap, so the last bar needs no gap after it.
      setCount(Math.max(1, Math.floor((width + 3) / METER_BAR_PITCH_PX)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, count] as const;
}

/**
 * Live microphone level while recording. The bars span the whole composer:
 * quiet dots form the track and new samples enter on the right, scrolling the
 * older ones left. A still dot replaces them when the user prefers reduced motion.
 */
function RecordingMeter({ levels, elapsed }: { levels: ReadonlyArray<number>; elapsed: number }) {
  const [trackRef, barCount] = useBarCount();
  const recent = levels.slice(-barCount);
  const bars = [...Array.from({ length: barCount - recent.length }, () => 0), ...recent];
  return (
    <div
      className="recording-meter flex min-h-7 min-w-0 flex-1 items-center gap-2.5 overflow-hidden px-1.5"
      aria-hidden="true"
    >
      <span className="size-2 flex-none rounded-full bg-destructive motion-safe:animate-pulse" />
      <span
        ref={trackRef}
        data-voice-meter=""
        className="flex h-[22px] min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden motion-reduce:invisible"
      >
        {bars.map((level, index) => (
          <span
            // The bars scroll left as new samples arrive, so their position is their identity.
            key={index}
            className="w-[3px] flex-none rounded-full bg-destructive/70 transition-[height] duration-[60ms]"
            style={{ height: `${Math.max(3, Math.round(level * 22))}px` }}
          />
        ))}
      </span>
      <span className="flex-none text-xs tabular-nums text-dim">{formatElapsed(elapsed)}</span>
    </div>
  );
}

/**
 * For a Wisp whose model cannot see images: which image model reads these
 * attachments for it, or why some will not reach it. Null when nothing needs vision.
 */
function missingVisionHint(attachments: ReadonlyArray<WorkspaceAttachment>, imageModel: string | null): string | null {
  const { images, pdfs } = attachmentsNeedingVision(attachments);
  if (imageModel && images > 0) {
    return `This Wisp's model can't see images, so ${imageModel} will read the attached ${images === 1 ? "image" : "images"} for it.`;
  }
  if (imageModel && pdfs > 0) {
    return `This Wisp's model can't see images. It reads the text of PDFs, and ${imageModel} reads any scanned pages for it.`;
  }
  if (images > 0) {
    return `This Wisp's model can't see images, so it won't be able to read the attached ${images === 1 ? "image" : "images"}.`;
  }
  if (pdfs > 0) {
    return "This Wisp's model can't see images. It can read the text of PDFs, but not scanned pages.";
  }
  return null;
}

function ComposerError({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      className="mb-2 mr-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-destructive"
    >
      <CircleAlertIcon aria-hidden="true" className="size-3.5 flex-none" />
      <span className="min-w-0 flex-1">{message}</span>
      {children}
    </div>
  );
}
