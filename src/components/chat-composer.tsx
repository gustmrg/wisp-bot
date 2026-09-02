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
      <div className="mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-border bg-muted px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-ring">
        <textarea
          autoFocus
          rows={1}
          className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 text-foreground outline-none leading-[18px] placeholder:text-dim field-sizing-content"
          aria-label={`Message ${chat.name}`}
          placeholder={`Message ${chat.name}`}
          value={draft}
          disabled={chat.kind === "circle"}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-secondary text-dim hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          aria-label="Start voice input"
        >
          <MicIcon aria-hidden="true" />
        </button>
        {working ? (
          <button
            type="button"
            className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground hover:opacity-[0.85] [&_svg]:size-3"
            aria-label="Stop response"
            onClick={onAbort}
          >
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </button>
        ) : null}
        <button
          type="submit"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground enabled:hover:opacity-[0.85] disabled:opacity-[0.35] [&_svg]:size-3.5"
          aria-label={working ? "Queue message" : "Send message"}
          disabled={!draft.trim() || acknowledging || chat.kind === "circle"}
        >
          <ArrowUpIcon aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
