import { useState } from "react";
import { CalendarClockIcon, CheckIcon, CircleAlertIcon, CircleStopIcon, CopyIcon } from "lucide-react";

import type { Message } from "@/chat-data";
import { splitMessageAttachments } from "../../shared/workspace";
import { useTimeZone } from "@/hooks/use-time-zone";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { AttachmentChips } from "@/components/attachment-chips";
import { MarkdownView } from "@/components/markdown-view";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface MessageViewProps {
  message: Message;
  dense?: boolean;
  onAnswer?: (answer: string) => void;
  onRetry?: () => void;
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
  const time = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone })
    : legacyTime;
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

function MessageView({ message, dense = false, onAnswer, onRetry }: MessageViewProps) {
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
    const failed = message.status === "failed";
    return (
      <div className="mt-[13px] mb-[5px] flex animate-message-in items-center justify-center gap-1.5 text-faint text-2xs">
        {failed ? (
          <CircleAlertIcon aria-hidden="true" className="size-3 flex-none" />
        ) : (
          <CircleStopIcon aria-hidden="true" className="size-3 flex-none" />
        )}
        <span>{failed ? "Failed" : "Stopped"}</span>
        {failed && message.retryable ? (
          <button
            type="button"
            className="rounded-md border border-black/[0.08] px-1.5 py-0.5 text-dim hover:bg-muted hover:text-foreground dark:border-white/[0.08]"
            onClick={onRetry}
          >
            Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (empty) return null;
  return (
    <div
      className={cn(
        "relative flex animate-message-in flex-col",
        outgoing ? "items-end" : "items-start",
        dense ? "mt-2" : "mt-3",
      )}
    >
      <div
        className={cn("message-row group/message-row flex max-w-full items-center", outgoing && "flex-row-reverse")}
        data-outgoing={outgoing}
      >
        <div
          className={cn(
            "message-bubble max-w-[min(820px,78vw)] rounded-[16px] px-2.5 py-[7px] leading-[1.42] select-text",
            outgoing
              ? "rounded-br-[5px] bg-bubble-out whitespace-pre-wrap text-white"
              : "rounded-bl-[5px] border border-border bg-bubble-in text-foreground",
          )}
        >
          {outgoing ? <OutgoingText text={message.text} /> : <MarkdownView text={message.text} />}
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
      message.scheduled ? (
        <div className={cn("mt-1 flex items-center gap-2 text-2xs text-faint", outgoing && "mr-1")}>
          {message.scheduled ? <ScheduledBadge scheduledAt={message.scheduled.scheduledAt} /> : null}
          {message.status === "queued" || message.status === "cancelled" || message.status === "failed" ? (
            <span>
              {message.status === "queued" ? "Queued" : message.status === "cancelled" ? "Stopped" : "Failed"}
            </span>
          ) : null}
          {!outgoing && message.status === "failed" && message.retryable ? (
            <button
              type="button"
              className="rounded-md border border-black/[0.08] px-1.5 py-0.5 text-dim hover:bg-muted hover:text-foreground dark:border-white/[0.08]"
              onClick={onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What the user typed, with the files attached to it shown as files rather than as the list the Wisp reads. */
function OutgoingText({ text }: { text: string }) {
  const { text: typed, attachments } = splitMessageAttachments(text);
  if (!attachments.length) return text;
  return (
    <>
      {typed}
      <AttachmentChips
        attachments={attachments}
        className={cn("whitespace-normal", typed && "mt-1.5")}
        chipClassName="border-white/25 bg-white/15"
      />
    </>
  );
}

/** Marks a message the backend sent from a scheduled message rather than one typed then. */
function ScheduledBadge({ scheduledAt }: { scheduledAt: string }) {
  const timeZone = useTimeZone();
  const when = new Date(scheduledAt).toLocaleString([], {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
