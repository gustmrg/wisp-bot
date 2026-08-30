import { useEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { ArrowUpIcon, MicIcon, SettingsIcon } from "lucide-react";

import type { Chat, ChatCollection } from "@/chat-data";
import { getCircleMembers } from "@/lib/circle-members";
import { ChatAvatar } from "@/components/chat-avatar";
import { MessageView } from "@/components/message-view";

interface ChatPanelProps {
  chat: Chat;
  chats: ChatCollection;
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
    <main className="main">
      <header className="chat-header">
        <div className="chat-heading">
          <ChatAvatar chat={chat} chats={chats} size="sm" />
          <span>{chat.name}</span>
        </div>
        <div className="chat-header-actions">
          {chat.isCircle ? <button className="circle-member-count" type="button" aria-label={`View circle participants (${members.length})`} title={members.map((member) => member.name).join(", ") || "No Wisps in this circle"} onClick={onOpenDetails}>{members.length} {members.length === 1 ? "Wisp" : "Wisps"}</button> : null}
        <button className="icon-button" type="button" aria-label={chat.isCircle ? "Open circle settings" : "Open Wisp settings"} title={chat.isCircle ? "Circle settings" : "Wisp settings"} onClick={onOpenDetails}>
          <SettingsIcon aria-hidden="true" />
        </button>
        </div>
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
            <div className="working-row"><ChatAvatar chat={chat} chats={chats} size="sm" /><span>{chat.name} is working…</span></div>
          ) : null}
        </div>
      </div>

      <form className="composer-zone" onSubmit={onSubmit}>
        {working ? <div className="status-line">Working on your request</div> : null}
        <div className="composer">
          <textarea
            ref={composerInputRef}
            rows={1}
            aria-label={`Message ${chat.name}`}
            placeholder={`Message ${chat.name}`}
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <button type="button" className="voice-button" aria-label="Start voice input">
            <MicIcon aria-hidden="true" />
          </button>
          <button type="submit" className="send-button" aria-label="Send message" disabled={!draft.trim()}>
            <ArrowUpIcon aria-hidden="true" />
          </button>
        </div>
      </form>
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };
