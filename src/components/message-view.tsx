import { CheckIcon, CopyIcon, MoreHorizontalIcon, ReplyIcon, SmilePlusIcon } from "lucide-react";

import type { Message } from "@/chat-data";

interface MessageViewProps {
  message: Message;
  onAnswer?: (answer: string) => void;
}

function MessageTools({ text, time }: { text: string; time?: string }) {
  return (
    <span className="message-tools">
      {time ? <time>{time}</time> : null}
      <button type="button" aria-label="Add reaction"><SmilePlusIcon /></button>
      <button type="button" aria-label="Reply"><ReplyIcon /></button>
      <button type="button" aria-label="Copy message" onClick={() => void navigator.clipboard?.writeText(text)}><CopyIcon /></button>
      <button type="button" aria-label="More message actions"><MoreHorizontalIcon /></button>
    </span>
  );
}

function MessageView({ message, onAnswer }: MessageViewProps) {
  if (message.type === "time") {
    return <div className="time-divider"><span>{message.text}</span></div>;
  }

  if (message.type === "card") {
    return (
      <div className="message-row incoming">
        <div className="message-bubble status-card">
          <ul>
            {message.items.map((item) => (
              <li key={item.label}><CheckIcon aria-hidden="true" /><span><strong>{item.label}</strong> — {item.text}</span></li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (message.type === "prompt") {
    return (
      <div className="message-row incoming">
        <section className="prompt-card" aria-label={message.question}>
          <strong>{message.question}</strong>
          {message.answer ? (
            <div className="prompt-answer"><span>{message.answer}</span><CheckIcon aria-hidden="true" /></div>
          ) : (
            <div className="prompt-options">
              {message.options.map((option) => (
                <button type="button" key={option.key} onClick={() => onAnswer?.(option.label)}>
                  <kbd>{option.key}</kbd><span>{option.label}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  const outgoing = message.type === "outgoing";
  return (
    <div className={`message-row ${outgoing ? "outgoing" : "incoming"}`}>
      <div className="message-with-tools">
        <div className="message-bubble">{message.text}</div>
        <MessageTools text={message.text} time={message.time} />
      </div>
      {message.reactions?.length ? (
        <div className="message-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction}>{reaction}</button>)}</div>
      ) : null}
    </div>
  );
}

export { MessageView };
export type { MessageViewProps };
