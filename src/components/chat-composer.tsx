import { useNarrowScreen } from "@/hooks/use-narrow-screen";
import { useBackendInstanceId } from "@/features/backend/backend-provider";
import { loadDraft, saveDraft } from "@/features/drafts/draft-storage";
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
  onConfigure?: () => void;
  onAbort: () => void;
  onSend: (text: string) => void | Promise<boolean>;
  connected?: boolean;
}

export function ChatComposer({
  chat,
  status,
  activity,
  error,
  acknowledging,
  onConfigure,
  onAbort,
  onSend,
  connected = true,
}: ChatComposerProps) {
  const instanceId = useBackendInstanceId();
  const narrow = useNarrowScreen();
  const [draft, setDraft] = useState(() => loadDraft(instanceId, chat.id));
  const [sending, setSending] = useState(false);
  const working = status === "working";
  const needsConfiguration = status === "configuration_required";
  const canSend = connected && !sending && (status === "idle" || working) && !acknowledging && chat.kind === "wisp";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    setSending(true);
    void Promise.resolve(onSend(text))
      .then((accepted) => {
        if (accepted === false) return;
        setDraft("");
        saveDraft(instanceId, chat.id, "");
      })
      .finally(() => setSending(false));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form className="flex-none px-3 pb-3" onSubmit={handleSubmit}>
      <div className="min-h-[22px] pl-2.5 text-[11px] text-dim" role="status">
        {!connected ? (
          "Connection unavailable. Your draft stays on this device."
        ) : chat.kind === "circle" ? (
          "Circle conversations are not enabled yet"
        ) : needsConfiguration ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span>Choose a provider and model before sending a message.</span>
            {onConfigure ? (
              <button
                type="button"
                className="font-medium text-primary underline underline-offset-2"
                onClick={onConfigure}
              >
                Configure AI model
              </button>
            ) : null}
          </div>
        ) : (
          (error ?? activity ?? (acknowledging ? "Queueing your message…" : null))
        )}
      </div>
      <div className="mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-border bg-muted px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-ring">
        <textarea
          autoFocus={!narrow}
          rows={1}
          className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 text-foreground outline-none leading-[18px] placeholder:text-dim field-sizing-content"
          aria-label={`Message ${chat.name}`}
          placeholder={`Message ${chat.name}`}
          value={draft}
          disabled={chat.kind === "circle" || sending}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft(value);
            saveDraft(instanceId, chat.id, value);
          }}
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
            disabled={!connected}
          >
            <SquareIcon aria-hidden="true" fill="currentColor" />
          </button>
        ) : null}
        <button
          type="submit"
          className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-primary text-primary-foreground enabled:hover:opacity-[0.85] disabled:opacity-[0.35] [&_svg]:size-3.5"
          aria-label={working ? "Queue message" : "Send message"}
          disabled={!draft.trim() || !canSend}
        >
          <ArrowUpIcon aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
