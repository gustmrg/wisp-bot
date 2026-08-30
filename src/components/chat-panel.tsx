import { useEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { MicIcon, PaperclipIcon, SendIcon, SettingsIcon } from "lucide-react";

import type { Chat } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { MessageView } from "@/components/message-view";

interface ChatPanelProps {
  chat: Chat;
  draft: string;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  working: boolean;
  onAnswerPrompt: (messageIndex: number, answer: string) => void;
  onDraftChange: (draft: string) => void;
  onOpenDetails: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ChatPanel({
  chat,
  draft,
  composerInputRef,
  working,
  onAnswerPrompt,
  onDraftChange,
  onOpenDetails,
  onSubmit,
}: ChatPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);

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
    <main className="main">
      <header className="chat-header">
        <div className="chat-heading">
          <ChatAvatar chat={chat} size="sm" />
          <span>{chat.name}</span>
        </div>
        <button className="icon-button" type="button" aria-label="Open Wisp settings" title="Wisp settings" onClick={onOpenDetails}>
          <SettingsIcon aria-hidden="true" />
        </button>
      </header>

      <div className="transcript" ref={transcriptRef} tabIndex={0} aria-label={`${chat.name} conversation`}>
        <div className="transcript-inner" role="log" aria-live="polite">
          {chat.messages.map((message, index) => (
            <MessageView
              key={`${chat.id}-${message.type}-${index}`}
              message={message}
              onAnswer={(answer) => onAnswerPrompt(index, answer)}
            />
          ))}
          {working ? (
            <div className="working-row"><ChatAvatar chat={chat} size="sm" /><span>{chat.name} is working…</span></div>
          ) : null}
        </div>
      </div>

      <form className="composer-zone" onSubmit={onSubmit}>
        {working ? <div className="status-line">Working on your request</div> : null}
        <div className="composer">
          <button type="button" className="composer-button" aria-label="Attach file" onClick={() => composerInputRef.current?.focus()}>
            <PaperclipIcon aria-hidden="true" />
          </button>
          <textarea
            ref={composerInputRef}
            rows={1}
            aria-label={`Message ${chat.name}`}
            placeholder={`Message ${chat.name}`}
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <button type={draft.trim() ? "submit" : "button"} className="voice-button" aria-label={draft.trim() ? "Send message" : "Start voice input"}>
            {draft.trim() ? <SendIcon aria-hidden="true" /> : <MicIcon aria-hidden="true" />}
          </button>
        </div>
      </form>
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };
