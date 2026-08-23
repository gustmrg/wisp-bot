import {
  Bubble,
  BubbleContent,
  BubbleReactions,
} from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Message as MessageRow,
  MessageContent,
} from "@/components/ui/message";
import type { Message } from "@/chat-data";

interface MessageViewProps {
  message: Message;
}

function MessageView({ message }: MessageViewProps) {
  if (message.type === "time") {
    return (
      <Marker className="justify-center py-2">
        <MarkerContent>{message.text}</MarkerContent>
      </Marker>
    );
  }

  if (message.type === "card") {
    return (
      <MessageRow align="start">
        <MessageContent>
          <Bubble variant="outline" align="start">
            <BubbleContent>
              <ul className="status-list">
                {message.items.map((item) => (
                  <li key={item.label}>
                    <span className="status-check" aria-hidden="true">
                      ✓
                    </span>
                    <span>
                      <strong>{item.label}</strong> → {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </MessageRow>
    );
  }

  const isOutgoing = message.type === "outgoing";
  const alignment = isOutgoing ? "end" : "start";

  return (
    <MessageRow align={alignment}>
      <MessageContent>
        <Bubble variant={isOutgoing ? "default" : "muted"} align={alignment}>
          <BubbleContent>{message.text}</BubbleContent>
          {message.reaction ? (
            <BubbleReactions side="bottom" align="end">
              {message.reaction}
            </BubbleReactions>
          ) : null}
        </Bubble>
      </MessageContent>
    </MessageRow>
  );
}

export { MessageView };
export type { MessageViewProps };
