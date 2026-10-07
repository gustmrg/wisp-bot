import {
  ArrowUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileIcon,
  LoaderCircleIcon,
  MicIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { ScheduleSendPicker } from "@/components/schedule-send-picker";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { DEFAULT_PREFERENCES } from "@/lib/app-preferences";
import { formatShortcut, matchesShortcut, SCHEDULE_SEND_SHORTCUT } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { ChatSummary, ManagedConversationStatus } from "../../shared/conversations";
import type { VoiceLanguage, VoiceProviderId } from "../../shared/voice";
import { messageWithAttachments, type WorkspaceAttachment } from "../../shared/workspace";

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
  chat: ChatSummary;
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
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  // Attaching picks files on this computer, so a server elsewhere cannot use them.
  const working = status === "working";
  const needsConfiguration = status === "configuration_required";
  const canSend = (status === "idle" || working) && !acknowledging && chat.kind === "wisp";
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
  const canSchedule = Boolean(onSchedule) && chat.kind === "wisp" && hasDraft && !voiceBusy && !scheduling;
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
    setScheduleOpen(false);
    setDraft("");
    setAttachments([]);
    setAttachError("");
    textareaRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
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
      if (canSchedule) setScheduleOpen(true);
      return;
    }
    if (enterToSend && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form className="chat-composer flex-none px-3 pb-3" onSubmit={handleSubmit}>
      <div className="min-h-[22px] pl-2.5 text-xs text-dim" role="status">
        {chat.kind === "circle" ? (
          "Circle conversations are not enabled yet"
        ) : needsConfiguration ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
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
        ) : acknowledging ? (
          "Queueing your message…"
        ) : null}
      </div>
      {attachments.length ? (
        <ul className="mx-auto mb-1.5 flex w-full max-w-[1400px] flex-wrap gap-1.5" aria-label="Attached files">
          {attachments.map((file) => (
            <li
              key={file.path}
              className="flex max-w-[240px] items-center gap-1 rounded-md border border-border bg-muted py-0.5 pl-1.5 pr-0.5 text-xs [&_svg]:size-3"
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
                  onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}
                >
                  <XIcon aria-hidden="true" />
                </button>
              </ComposerTooltip>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={cn(
          "composer-input mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-border bg-muted px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-ring",
          recording && "border-destructive/60 focus-within:border-destructive/60",
        )}
      >
        {recording ? (
          <ComposerTooltip message="Cancel recording (Esc)">
            <button
              type="button"
              className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
              aria-label="Cancel recording"
              onClick={cancelVoiceInput}
            >
              <XIcon aria-hidden="true" />
            </button>
          </ComposerTooltip>
        ) : chat.kind === "wisp" ? (
          <ComposerTooltip message={attaching ? "Copying files to the workspace…" : "Attach files"}>
            <button
              type="button"
              className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-[0.35] [&_svg]:size-3.5"
              aria-label="Attach files"
              disabled={attaching}
              onClick={() => void attachFiles()}
            >
              <PaperclipIcon aria-hidden="true" />
            </button>
          </ComposerTooltip>
        ) : null}
        {recording ? <RecordingMeter levels={voiceInput.levels} elapsed={voiceInput.elapsed} /> : null}
        <textarea
          ref={textareaRef}
          hidden={recording}
          autoFocus={autoFocus}
          rows={1}
          className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 text-foreground outline-none leading-[18px] placeholder:text-dim field-sizing-content"
          aria-label={`Message ${chat.name}`}
          placeholder={transcribing ? "Transcribing…" : `Message ${chat.name}`}
          value={draft}
          disabled={chat.kind === "circle"}
          readOnly={transcribing}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <ComposerTooltip message={voiceHint}>
          <button
            type="button"
            className={cn(
              "flex size-[27px] flex-none items-center justify-center rounded-full border-0 [&_svg]:size-3.5 disabled:opacity-[0.35]",
              recording
                ? "bg-destructive text-white hover:opacity-[0.85] [&_svg]:size-3"
                : "bg-secondary text-dim enabled:hover:bg-accent enabled:hover:text-foreground",
            )}
            aria-label={
              recording ? "Stop recording and transcribe" : transcribing ? "Transcribing" : "Start voice input"
            }
            aria-keyshortcuts={voice.shortcut.replaceAll("Ctrl", "Control").replace(/Key([A-Z])$/, "$1")}
            disabled={voiceDisabled}
            onClick={toggleVoiceInput}
          >
            {recording ? (
              <SquareIcon aria-hidden="true" fill="currentColor" />
            ) : transcribing ? (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            ) : (
              <MicIcon aria-hidden="true" />
            )}
          </button>
        </ComposerTooltip>
        {working ? (
          <ComposerTooltip message="Stop response">
            <button
              type="button"
              className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground hover:opacity-[0.85] [&_svg]:size-3"
              aria-label="Stop response"
              onClick={onAbort}
            >
              <SquareIcon aria-hidden="true" fill="currentColor" />
            </button>
          </ComposerTooltip>
        ) : null}
        <div className="flex flex-none items-center">
          <ComposerTooltip message={`${working ? "Queue message" : "Send message"}${enterToSend ? " (Enter)" : ""}`}>
            <button
              type="submit"
              className={cn(
                "flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground enabled:hover:opacity-[0.85] disabled:opacity-[0.35] [&_svg]:size-3.5",
                onSchedule && chat.kind === "wisp" && "w-[25px] rounded-r-none pl-0.5",
              )}
              aria-label={working ? "Queue message" : "Send message"}
              disabled={!hasDraft || !canSend || voiceBusy}
            >
              <ArrowUpIcon aria-hidden="true" />
            </button>
          </ComposerTooltip>
          {onSchedule && chat.kind === "wisp" ? (
            <Popover
              open={scheduleOpen}
              onOpenChange={(open) => {
                setScheduleOpen(open && canSchedule);
                if (!open) setScheduleError("");
              }}
            >
              <ComposerTooltip message={`Schedule send (${scheduleShortcutLabel})`}>
                <PopoverTrigger
                  type="button"
                  className="flex h-[27px] w-[17px] flex-none items-center justify-center rounded-r-full border-0 border-l border-primary-foreground/25 bg-primary pr-0.5 text-primary-foreground enabled:hover:opacity-[0.85] disabled:opacity-[0.35] [&_svg]:size-3"
                  aria-label="Schedule send"
                  disabled={!canSchedule}
                >
                  <ChevronDownIcon aria-hidden="true" />
                </PopoverTrigger>
              </ComposerTooltip>
              <PopoverContent>
                <PopoverTitle>Schedule send</PopoverTitle>
                <ScheduleSendPicker busy={scheduling} onPick={(at) => void schedule(at)} />
                {scheduleError ? (
                  <p role="alert" className="px-2 pt-1.5 text-xs text-destructive">
                    {scheduleError}
                  </p>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </form>
  );
}

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
    <div className="flex min-h-[26px] min-w-0 flex-1 items-center gap-2.5 overflow-hidden" aria-hidden="true">
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
