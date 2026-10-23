import { useState } from "react";
import {
  CalendarClockIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleStopIcon,
  CopyIcon,
  LifeBuoyIcon,
  RepeatIcon,
} from "lucide-react";

import type { Message, Wisp } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";
import { splitMessageAttachments } from "../../shared/workspace";
import { useRevealedText } from "@/hooks/use-reply-pace";
import { useTimeFormat, useTimeZone } from "@/hooks/use-time-zone";
import { clockTimeOptions, formatClockTime } from "@/lib/clock-time";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { AttachmentChips } from "@/components/attachment-chips";
import { MarkdownView } from "@/components/markdown-view";
import { FileMentionedText } from "@/components/file-mention";
import { MentionedText, type WispMentions } from "@/components/wisp-mention";
import { MessageSteps, type ProcessStates } from "@/components/message-steps";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface MessageViewProps {
  message: Message;
  dense?: boolean;
  /** In a circle, the Wisp that wrote an incoming message, named above it when `showAuthor` is set. */
  author?: Wisp;
  showAuthor?: boolean;
  /** In a circle, its members, whose `@` mentions are set apart and open their conversation. */
  mentions?: WispMentions;
  /** In a direct conversation, the user's `@` mentions of workspace files are set apart. */
  fileMentions?: boolean;
  onAnswer?: (answer: string) => void;
  onRetry?: () => void;
  /** What is known of each background process the conversation's steps started. */
  processStates?: ProcessStates;
}

function MessageTools({
  text,
  createdAt,
  legacyTime,
  outgoing,
}: {
  text: string;
  createdAt?: string;
  legacyTime?: string;
  outgoing: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const time = createdAt ? formatClockTime(new Date(createdAt), timeZone, timeFormat) : legacyTime;
  if (!time && !text) return null;

  function copyMessage() {
    void copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <span
      className={cn(
        "message-tools flex flex-none items-center gap-px opacity-0 transition-opacity duration-100 group-hover/message-row:opacity-100 focus-within:opacity-100",
        outgoing ? "mr-[7px]" : "ml-[7px]",
      )}
    >
      {time ? (
        <time className="mr-[3px] text-faint text-2xs" dateTime={createdAt}>
          {time}
        </time>
      ) : null}
      {text ? (
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          className="flex size-4 items-center justify-center rounded-[4px] text-faint outline-none hover:bg-black/[0.06] hover:text-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue dark:hover:bg-white/[0.06] dark:hover:text-[#dddddd] [&_svg]:size-[11px]"
          onClick={copyMessage}
        >
          {copied ? <CheckIcon aria-hidden="true" className="text-green" /> : <CopyIcon aria-hidden="true" />}
        </button>
      ) : null}
    </span>
  );
}

function MessageView({
  message,
  dense = false,
  author,
  showAuthor = false,
  mentions,
  fileMentions,
  onAnswer,
  onRetry,
  processStates,
}: MessageViewProps) {
  // Called before anything can return, so a reply is seen while it is still empty and streaming.
  const reveal = useRevealedText(
    message.type === "incoming" ? message.id : undefined,
    message.type === "incoming" ? message.text : "",
    message.status,
  );
  if (message.type === "incoming" && message.steps?.length && !message.text) {
    return (
      <div className="relative flex flex-col items-start">
        {author && showAuthor ? (
          <span className="message-author">
            <WispAvatar wisp={author} size="sm" />
            {author.name}
          </span>
        ) : null}
        <MessageSteps steps={message.steps} processStates={processStates} />
      </div>
    );
  }
  if (message.type === "time") {
    return (
      <div className="mt-[13px] mb-[5px] flex items-center justify-center text-faint text-2xs">
        <span>{message.text}</span>
      </div>
    );
  }

  if (message.type === "card") {
    return (
      <div className="relative mt-3 flex animate-message-in flex-col items-start">
        <div className="message-card max-w-[min(820px,78vw)] rounded-[11px] border border-border bg-card px-[11px] py-[9px] leading-[1.42] select-text">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {message.items.map((item) => (
              <li key={item.label} className="flex items-start gap-[7px]">
                <CheckIcon aria-hidden="true" className="mt-0.5 size-[13px] flex-none text-dim" />
                <span>
                  <strong className="font-semibold">{item.label}</strong> — {item.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (message.type === "prompt") {
    return (
      <div className="relative mt-3 flex animate-message-in flex-col items-start">
        <section
          className="message-prompt w-[min(820px,78vw)] rounded-[11px] border border-border bg-popover p-2.5"
          aria-label={message.question}
        >
          <strong className="mb-[9px] block">{message.question}</strong>
          {message.answer ? (
            <div className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2 py-[7px] text-left">
              <span className="flex-1 text-dim">{message.answer}</span>
              <CheckIcon aria-hidden="true" className="size-3.5 text-green" />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {message.options.map((option) => (
                <button
                  type="button"
                  key={option.key}
                  className="flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2 py-[7px] text-left hover:border-ring hover:bg-muted"
                  onClick={() => onAnswer?.(option.label)}
                >
                  <kbd className="inline-flex size-5 items-center justify-center rounded-[5px] bg-secondary text-2xs text-dim [font-family:inherit]">
                    {option.key}
                  </kbd>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  const outgoing = message.type === "outgoing";
  const empty = !message.text.trim();
  if (empty && (message.status === "cancelled" || message.status === "failed")) {
    return (
      <div className="mt-[13px] mb-[5px] flex animate-message-in items-center justify-center gap-1.5 text-faint text-2xs">
        {message.status === "failed" ? (
          <FailedNotice
            reason={message.type === "incoming" ? message.error?.message : undefined}
            onRetry={message.retryable ? onRetry : undefined}
          />
        ) : (
          <>
            <CircleStopIcon aria-hidden="true" className="size-3 flex-none" />
            <span>Stopped</span>
          </>
        )}
      </div>
    );
  }
  if (empty || (!outgoing && !reveal.text.trim())) return null;
  return (
    <div
      className={cn(
        "relative flex animate-message-in flex-col",
        outgoing ? "items-end" : "items-start",
        dense ? "mt-2" : "mt-3",
      )}
    >
      {author && showAuthor && !outgoing ? (
        <span className="message-author">
          <WispAvatar wisp={author} size="sm" />
          {author.name}
        </span>
      ) : null}
      <div
        className={cn("message-row group/message-row flex max-w-full items-center", outgoing && "flex-row-reverse")}
        data-outgoing={outgoing}
        data-authored={author && !outgoing ? true : undefined}
      >
        <div
          className={cn(
            "message-bubble max-w-[min(820px,78vw)] rounded-[16px] px-2.5 py-[7px] leading-[1.42] select-text",
            outgoing
              ? "rounded-br-[5px] bg-bubble-out whitespace-pre-wrap text-bubble-out-foreground"
              : "rounded-bl-[5px] border border-border bg-bubble-in text-foreground",
          )}
        >
          {outgoing ? (
            <OutgoingText text={message.text} mentions={mentions} fileMentions={fileMentions} />
          ) : (
            <IncomingText reveal={reveal} mentions={mentions} />
          )}
        </div>
        <MessageTools
          text={outgoing ? splitMessageAttachments(message.text).text : message.text}
          createdAt={message.createdAt}
          legacyTime={message.time}
          outgoing={outgoing}
        />
      </div>
      {message.reactions?.length ? (
        <div className="mt-[3px] flex gap-1">
          {message.reactions.map((reaction) => (
            <button
              type="button"
              key={reaction}
              className="rounded-[10px] border border-border bg-muted px-[7px] py-0.5 text-xs text-dim"
            >
              {reaction}
            </button>
          ))}
        </div>
      ) : null}
      {message.status === "queued" ||
      message.status === "cancelled" ||
      message.status === "failed" ||
      message.scheduled ||
      message.job ||
      message.fallbackModel ? (
        <div className={cn("mt-1 flex items-center gap-2 text-2xs text-faint", outgoing && "mr-1")}>
          {message.scheduled ? <ScheduledBadge scheduledAt={message.scheduled.scheduledAt} /> : null}
          {message.job ? <JobBadge title={message.job.title} /> : null}
          {message.fallbackModel ? <FallbackBadge model={message.fallbackModel} /> : null}
          {message.status === "queued" || message.status === "cancelled" ? (
            <span>{message.status === "queued" ? "Queued" : "Stopped"}</span>
          ) : null}
          {message.status === "failed" ? (
            <FailedNotice
              reason={outgoing ? undefined : message.error?.message}
              onRetry={!outgoing && message.retryable ? onRetry : undefined}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Marks a message that failed, in the error colour so it stands apart from a
 * stopped or queued one, with the reason on one line and in full on hover.
 */
function FailedNotice({ reason, onRetry }: { reason?: string; onRetry?: () => void }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-destructive">
      <CircleAlertIcon aria-hidden="true" className="size-3 flex-none" />
      {reason ? (
        <Tooltip>
          <TooltipTrigger render={<span />} className="min-w-0 max-w-[min(520px,70vw)] truncate" delay={300}>
            {`Failed · ${reason}`}
          </TooltipTrigger>
          <TooltipContent className="max-w-[360px]">{reason}</TooltipContent>
        </Tooltip>
      ) : (
        <span>Failed</span>
      )}
      {onRetry ? (
        <button
          type="button"
          className="rounded-md border border-black/[0.08] px-1.5 py-0.5 text-dim hover:bg-muted hover:text-foreground dark:border-white/[0.08]"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </span>
  );
}

/** A Wisp's reply, appearing at the person's chosen pace while it arrives; a click shows the rest at once. */
function IncomingText({ reveal, mentions }: { reveal: ReturnType<typeof useRevealedText>; mentions?: WispMentions }) {
  if (!reveal.revealing) return <MarkdownView text={reveal.text} mentions={mentions} />;
  return (
    <div data-revealing="" onClick={reveal.finish}>
      <MarkdownView text={reveal.text} mentions={mentions} />
    </div>
  );
}

/** What the user typed, with the files attached to it shown as files rather than as the list the Wisp reads. */
function OutgoingText({
  text,
  mentions,
  fileMentions,
}: {
  text: string;
  mentions?: WispMentions;
  fileMentions?: boolean;
}) {
  const { text: typed, attachments } = splitMessageAttachments(text);
  const written = mentions ? (
    <MentionedText text={typed} mentions={mentions} />
  ) : fileMentions ? (
    <FileMentionedText text={typed} />
  ) : (
    typed
  );
  if (!attachments.length) return written;
  // Above the text, where the composer shows them, so sending does not move them.
  return (
    <>
      <AttachmentChips
        attachments={attachments}
        className={cn("whitespace-normal", typed && "mb-1.5")}
        chipClassName="border-current/25 bg-current/10"
      />
      {written}
    </>
  );
}

/** Marks a Wisp's message that one of its jobs sent, with no request before it. */
function JobBadge({ title }: { title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className="inline-flex min-w-0 items-center gap-1" delay={300}>
        <RepeatIcon aria-hidden="true" className="size-3 flex-none" />
        <span className="truncate">{`Job · ${title}`}</span>
      </TooltipTrigger>
      <TooltipContent>{`Sent by the job "${title}", which ran in the background`}</TooltipContent>
    </Tooltip>
  );
}

/** Marks a Wisp's reply that its fallback model wrote because its own model failed. */
function FallbackBadge({ model }: { model: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className="inline-flex min-w-0 items-center gap-1" delay={300}>
        <LifeBuoyIcon aria-hidden="true" className="size-3 flex-none" />
        <span className="truncate">{`Fallback · ${model}`}</span>
      </TooltipTrigger>
      <TooltipContent>{`Answered by the fallback model ${model} because this Wisp's model failed`}</TooltipContent>
    </Tooltip>
  );
}

/** Marks a message the backend sent from a scheduled message rather than one typed then. */
function ScheduledBadge({ scheduledAt }: { scheduledAt: string }) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const when = new Date(scheduledAt).toLocaleString([], {
    timeZone,
    month: "short",
    day: "numeric",
    ...clockTimeOptions(timeFormat),
  });
  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className="inline-flex items-center gap-1" delay={300}>
        <CalendarClockIcon aria-hidden="true" className="size-3 flex-none" />
        Scheduled
      </TooltipTrigger>
      <TooltipContent>{`Sent automatically · scheduled ${when}`}</TooltipContent>
    </Tooltip>
  );
}

export { MessageView };
export type { MessageViewProps };
