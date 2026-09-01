import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import type { Message } from "@/chat-data";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { MarkdownView } from "@/components/markdown-view";

interface MessageViewProps {
  message: Message;
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
  const time = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
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
        "flex flex-none items-center gap-px opacity-0 transition-opacity duration-100 group-hover/message-row:opacity-100 focus-within:opacity-100",
        outgoing ? "mr-[7px]" : "ml-[7px]",
      )}
    >
      {time ? (
        <time className="mr-[3px] text-faint text-[10px]" dateTime={createdAt}>
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

function MessageView({ message, onAnswer, onRetry }: MessageViewProps) {
  if (message.type === "time") {
    return (
      <div className="mt-[13px] mb-[5px] flex items-center justify-center text-faint text-[10.5px]">
        <span>{message.text}</span>
      </div>
    );
  }

  if (message.type === "card") {
    return (
      <div className="relative mt-[5px] flex animate-message-in flex-col items-start">
        <div className="max-w-[min(820px,78vw)] rounded-[11px] border border-black/[0.06] bg-[#f6f6f6] px-[11px] py-[9px] leading-[1.42] select-text dark:border-white/[0.06] dark:bg-[#1b1b1b]">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {message.items.map((item) => (
              <li key={item.label} className="flex items-start gap-[7px]">
                <CheckIcon
                  aria-hidden="true"
                  className="mt-0.5 size-[13px] flex-none text-[#666666] dark:text-[#a7a7a7]"
                />
                <span>
                  <strong className="font-[650]">{item.label}</strong> — {item.text}
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
      <div className="relative mt-[5px] flex animate-message-in flex-col items-start">
        <section
          className="w-[min(820px,78vw)] rounded-[11px] border border-black/[0.07] bg-[#f4f4f4] p-2.5 dark:border-white/[0.07] dark:bg-[#202020]"
          aria-label={message.question}
        >
          <strong className="mb-[9px] block">{message.question}</strong>
          {message.answer ? (
            <div className="flex w-full items-center gap-2 rounded-lg border border-black/[0.07] bg-white px-2 py-[7px] text-left dark:border-white/[0.07] dark:bg-[#191919]">
              <span className="flex-1 text-[#555555] dark:text-[#bdbdbd]">{message.answer}</span>
              <CheckIcon aria-hidden="true" className="size-3.5 text-green" />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {message.options.map((option) => (
                <button
                  type="button"
                  key={option.key}
                  className="flex w-full items-center gap-2 rounded-lg border border-black/[0.07] bg-white px-2 py-[7px] text-left hover:border-black/[0.13] hover:bg-[#eeeeee] dark:border-white/[0.07] dark:bg-[#191919] dark:hover:border-white/[0.13] dark:hover:bg-[#252525]"
                  onClick={() => onAnswer?.(option.label)}
                >
                  <kbd className="inline-flex size-5 items-center justify-center rounded-[5px] bg-[#e9e9e9] text-[10px] text-[#606060] [font-family:inherit] dark:bg-[#292929] dark:text-[#aaaaaa]">
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
  if (message.status === "streaming" && !message.text.trim()) return null;
  return (
    <div className={cn("relative mt-[5px] flex animate-message-in flex-col", outgoing ? "items-end" : "items-start")}>
      <div className={cn("group/message-row flex max-w-full items-center", outgoing && "flex-row-reverse")}>
        <div
          className={cn(
            "max-w-[min(820px,78vw)] rounded-[11px] px-2.5 py-[7px] text-[#262626] leading-[1.42] select-text dark:text-[#e8e8e8]",
            outgoing ? "bg-bubble-out whitespace-pre-wrap" : "bg-bubble-in",
          )}
        >
          {outgoing ? message.text : <MarkdownView text={message.text} />}
        </div>
        <MessageTools text={message.text} createdAt={message.createdAt} legacyTime={message.time} outgoing={outgoing} />
      </div>
      {message.reactions?.length ? (
        <div className="mt-[3px] flex gap-1">
          {message.reactions.map((reaction) => (
            <button
              type="button"
              key={reaction}
              className="rounded-[10px] border border-black/[0.08] bg-[#f0f0f0] px-[7px] py-0.5 text-[11px] text-[#555555] dark:border-white/[0.08] dark:bg-[#1c1c1c] dark:text-[#bbbbbb]"
            >
              {reaction}
            </button>
          ))}
        </div>
      ) : null}
      {(message.status === "queued" || message.status === "cancelled" || message.status === "failed") ? (
        <div className={cn("mt-1 flex items-center gap-2 text-[10.5px] text-faint", outgoing && "mr-1")}>
          <span>
            {message.status === "queued"
              ? "Queued"
              : message.status === "cancelled"
                ? "Stopped"
                : "Failed"}
          </span>
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

export { MessageView };
export type { MessageViewProps };
