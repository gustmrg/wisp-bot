import { useEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { ArrowUpIcon, MicIcon, SettingsIcon } from "lucide-react";

import type { Chat, ChatCollection } from "@/chat-data";
import { getCircleMembers } from "@/lib/circle-members";
import { iconButton, mainPanel } from "@/lib/ui-classes";
import { ChatAvatar } from "@/components/chat-avatar";
import { MessageView } from "@/components/message-view";

interface ChatPanelProps {
  chat: Chat;
  chats: ChatCollection;
  draft: string;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  working: boolean;
  onAnswerPrompt: (messageId: string | undefined, answer: string) => void;
  onDraftChange: (draft: string) => void;
  onOpenDetails: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ChatPanel({
  chat,
  chats,
  draft,
  composerInputRef,
  working,
  onAnswerPrompt,
  onDraftChange,
  onOpenDetails,
  onSubmit,
}: ChatPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const members = getCircleMembers(chat, chats);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [chat.id, chat.messages.length, working]);

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <main className={mainPanel}>
      <header className="flex h-11 flex-none items-center justify-between border-b border-black/[0.035] px-3.5 dark:border-white/[0.035]">
        <div className="inline-flex min-w-0 items-center gap-2 rounded-lg p-1">
          <ChatAvatar chat={chat} chats={chats} size="sm" />
          <span className="truncate font-semibold">{chat.name}</span>
        </div>
        <div className="flex flex-none items-center gap-2">
          {chat.isCircle ? <button className="rounded-md border-0 bg-transparent px-[7px] py-1 text-dim text-xs hover:bg-muted hover:text-foreground" type="button" aria-label={`View circle participants (${members.length})`} title={members.map((member) => member.name).join(", ") || "No Wisps in this circle"} onClick={onOpenDetails}>{members.length} {members.length === 1 ? "Wisp" : "Wisps"}</button> : null}
        <button className={iconButton} type="button" aria-label={chat.isCircle ? "Open circle settings" : "Open Wisp settings"} title={chat.isCircle ? "Circle settings" : "Wisp settings"} onClick={onOpenDetails}>
          <SettingsIcon aria-hidden="true" />
        </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none" ref={transcriptRef} tabIndex={0} aria-label={`${chat.name} conversation`}>
        <div className="mx-auto flex w-full max-w-[1400px] flex-col px-3.5 pt-1.5 pb-[22px]" role="log" aria-live="polite">
          {chat.messages.map((message, index) => (
            <MessageView
              key={message.id ?? `${chat.id}-${message.type}-${index}`}
              message={message}
              onAnswer={(answer) => onAnswerPrompt(message.id, answer)}
            />
          ))}
          {working ? (
            <div className="mt-3 flex items-center gap-2 text-dim text-xs [&_svg]:animate-working-pulse"><ChatAvatar chat={chat} chats={chats} size="sm" /><span>{chat.name} is working…</span></div>
          ) : null}
        </div>
      </div>

      <form className="flex-none px-3 pb-3" onSubmit={onSubmit}>
        {working ? <div className="h-[22px] pl-2.5 text-faint text-[11px]">Working on your request</div> : null}
        <div className="mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-black/[0.07] bg-[#f0f0f0] px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-black/[0.16] dark:border-white/[0.07] dark:bg-[#282828] dark:focus-within:border-white/[0.16]">
          <textarea
            ref={composerInputRef}
            rows={1}
            className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 outline-none text-[#202020] leading-[18px] placeholder:text-[#707070] field-sizing-content dark:text-[#ededed] dark:placeholder:text-[#7c7c7c]"
            aria-label={`Message ${chat.name}`}
            placeholder={`Message ${chat.name}`}
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <button type="button" className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#dedede] text-[#686868] hover:bg-[#d5d5d5] hover:text-[#333333] dark:bg-[#343434] dark:text-[#999999] dark:hover:bg-[#3b3b3b] dark:hover:text-[#e4e4e4] [&_svg]:size-3.5" aria-label="Start voice input">
            <MicIcon aria-hidden="true" />
          </button>
          <button type="submit" className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#202020] text-white enabled:hover:opacity-[0.85] disabled:opacity-[0.35] dark:bg-[#f0f0f0] dark:text-[#161616] [&_svg]:size-3.5" aria-label="Send message" disabled={!draft.trim()}>
            <ArrowUpIcon aria-hidden="true" />
          </button>
        </div>
      </form>
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };
