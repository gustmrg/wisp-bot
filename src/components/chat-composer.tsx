import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react";

import type { Chat, ManagedConversationStatus } from "../../shared/conversations";

export interface ChatComposerProps {
  chat: Chat;
  status: ManagedConversationStatus;
  activity?: string;
  error?: string;
  acknowledging: boolean;
  onAbort: () => void;
  onSend: (text: string) => void;
}

export function ChatComposer({ chat, status, activity, error, acknowledging, onAbort, onSend }: ChatComposerProps) {
  const [draft, setDraft] = useState("");
  const working = status === "working";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text || chat.kind === "circle") return;
    setDraft("");
    onSend(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form className="flex-none px-3 pb-3" onSubmit={handleSubmit}>
      <div className="h-[22px] pl-2.5 text-[11px] text-faint" role="status">
        {chat.kind === "circle"
          ? "Circle conversations are not enabled yet"
          : (error ??
            activity ??
            (status === "configuration_required" ? "Configure a provider and model in Settings" : null) ??
            (acknowledging ? "Queueing your message…" : null) ??
            (working ? "Working on your request" : null))}
      </div>
      <div className="mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-black/[0.07] bg-[#f0f0f0] px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-black/[0.16] dark:border-white/[0.07] dark:bg-[#282828] dark:focus-within:border-white/[0.16]">
        <textarea
          autoFocus
          rows={1}
          className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 outline-none text-[#202020] leading-[18px] placeholder:text-[#707070] field-sizing-content dark:text-[#ededed] dark:placeholder:text-[#7c7c7c]"
          aria-label={`Message ${chat.name}`}
          placeholder={`Message ${chat.name}`}
          value={draft}
          disabled={chat.kind === "circle"}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#dedede] text-[#686868] hover:bg-[#d5d5d5] hover:text-[#333333] dark:bg-[#343434] dark:text-[#999999] dark:hover:bg-[#3b3b3b] dark:hover:text-[#e4e4e4] [&_svg]:size-3.5"
          aria-label="Start voice input"
        >
          <MicIcon aria-hidden="true" />
        </button>
        {working ? (
          <button
            type="button"
            className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#202020] text-white hover:opacity-[0.85] dark:bg-[#f0f0f0] dark:text-[#161616] [&_svg]:size-3"
            aria-label="Stop response"
            onClick={onAbort}
          >
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </button>
        ) : null}
        <button
          type="submit"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#202020] text-white enabled:hover:opacity-[0.85] disabled:opacity-[0.35] dark:bg-[#f0f0f0] dark:text-[#161616] [&_svg]:size-3.5"
          aria-label={working ? "Queue message" : "Send message"}
          disabled={!draft.trim() || acknowledging || chat.kind === "circle"}
        >
          <ArrowUpIcon aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
