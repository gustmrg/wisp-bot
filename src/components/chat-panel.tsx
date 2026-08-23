import type { FormEvent, RefObject } from "react";
import { PaperclipIcon, SendIcon } from "lucide-react";

import { ChatAvatar } from "@/components/chat-avatar";
import { MessageView } from "@/components/message-view";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Chat } from "@/chat-data";

interface ChatPanelProps {
  chat: Chat;
  draft: string;
  composerInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (draft: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ChatPanel({
  chat,
  draft,
  composerInputRef,
  onDraftChange,
  onSubmit,
}: ChatPanelProps) {
  return (
    <main className="main">
      <header className="chat-header">
        <ChatAvatar chat={chat} size="sm" />
        <h1>{chat.name}</h1>
      </header>

      <MessageScrollerProvider
        key={chat.id}
        autoScroll
        defaultScrollPosition="end"
      >
        <MessageScroller className="messages">
          <MessageScrollerViewport
            aria-label={`${chat.name} conversation`}
            aria-live="polite"
          >
            <MessageScrollerContent className="message-list">
              {chat.messages.map((message, index) => (
                <MessageScrollerItem
                  messageId={`${chat.id}-${index}`}
                  scrollAnchor={message.type === "outgoing"}
                  key={`${chat.id}-${message.type}-${index}`}
                >
                  <MessageView message={message} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form className="composer" onSubmit={onSubmit}>
        <InputGroup className="composer-input">
          <InputGroupInput
            ref={composerInputRef}
            type="text"
            aria-label={`Message ${chat.name}`}
            placeholder={`Message ${chat.name}`}
            autoComplete="off"
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
          />
          <InputGroupAddon align="inline-start">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label="Add attachment"
                    onClick={() => composerInputRef.current?.focus()}
                  />
                }
              >
                <PaperclipIcon />
              </TooltipTrigger>
              <TooltipContent>Add attachment</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
          <InputGroupAddon align="inline-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    variant="default"
                    size="icon-sm"
                    type="submit"
                    aria-label="Send message"
                    disabled={!draft.trim()}
                  />
                }
              >
                <SendIcon />
              </TooltipTrigger>
              <TooltipContent>Send message</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };
