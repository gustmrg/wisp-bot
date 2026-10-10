import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownIcon, ChevronLeftIcon, SettingsIcon } from "lucide-react";

import type { ChatView, Message } from "@/chat-data";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { chatName } from "@/lib/chat-schema";
import { withDateDividers } from "@/lib/date-dividers";
import { isAttached, type MessageWindow } from "@/lib/message-windows";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import { ChatAvatar } from "@/components/chat-avatar";
import { ChatComposer, type VoiceInputSettings } from "@/components/chat-composer";
import { Button } from "@/components/ui/button";
import { MessageView } from "@/components/message-view";
import { PendingMessagesBar } from "@/components/pending-messages-bar";
import type { MessageQueueController } from "@/hooks/use-message-queue";
import type { ScheduledMessagesController } from "@/hooks/use-scheduled-messages";
import { useTimeZone } from "@/hooks/use-time-zone";
import { ToolApprovalCard } from "@/components/tool-approval-card";

const NO_MESSAGES: ReadonlyArray<Message> = [];
const unavailable = async () => "This server cannot do that. Update it first.";
const NO_QUEUE = { update: unavailable, cancel: unavailable };
const NO_SCHEDULE = { update: unavailable, cancel: unavailable, sendNow: unavailable };
/** How close to an end of the transcript, in pixels, the view gets before the next page loads. */
const PAGE_EDGE_DISTANCE = 120;
/** How close to the bottom, in pixels, the view still counts as following the newest messages. */
const FOLLOW_DISTANCE = 24;

// The flash is drawn over the row, centered on the message rather than on the margin above it.
const messageRow =
  "relative data-[highlighted=true]:after:pointer-events-none data-[highlighted=true]:after:absolute data-[highlighted=true]:after:-inset-x-2 data-[highlighted=true]:after:top-1.5 data-[highlighted=true]:after:-bottom-1.5 data-[highlighted=true]:after:animate-message-highlight data-[highlighted=true]:after:rounded-lg";

/** What the last layout showed, to tell a new message from an older page or a newly opened window. */
interface TranscriptView {
  openKey: string;
  endKey: string;
  lastMessageId: string | undefined;
  attached: boolean;
  firstMessageId: string | undefined;
  firstMessageTop: number;
}

function messageElement(transcript: HTMLElement, messageId: string | undefined): HTMLElement | null {
  if (!messageId) return null;
  for (const element of transcript.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (element.dataset.messageId === messageId) return element;
  }
  return null;
}

function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_DISTANCE;
}

interface ChatPanelProps {
  hidden?: boolean;
  onBack?: () => void;
  chat: ChatView;
  /** The loaded part of the transcript; undefined until its first page arrives. */
  transcript: MessageWindow | undefined;
  status: ManagedConversationStatus;
  activity?: string;
  error?: string;
  acknowledging: boolean;
  approvals: ReadonlyArray<ToolApprovalRequest>;
  /** Auto-review is on, so approvals can offer a lasting Allow rule. */
  allowAlwaysAvailable?: boolean;
  onAnswerPrompt: (messageId: string | undefined, answer: string) => void;
  onAbort: () => void;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onShowLatest: () => void;
  onOpenDetails: () => void;
  onConfigure?: () => void;
  voice?: VoiceInputSettings;
  onConfigureVoice?: () => void;
  onRetry: (messageId: string | undefined) => void;
  onResolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onSend: (text: string) => void;
  /** Scheduled messages for every Wisp; absent when the backend cannot schedule them. */
  scheduledMessages?: ScheduledMessagesController;
  /** Messages waiting for every Wisp; absent when the backend has no queue. */
  messageQueue?: MessageQueueController;
}

function ChatPanel({
  hidden = false,
  onBack,
  chat,
  transcript,
  status,
  activity,
  error,
  acknowledging,
  approvals,
  allowAlwaysAvailable = false,
  onAnswerPrompt,
  onAbort,
  onLoadOlder,
  onLoadNewer,
  onShowLatest,
  onOpenDetails,
  onConfigure,
  voice,
  onConfigureVoice,
  onRetry,
  onResolveApproval,
  onSend,
  scheduledMessages,
  messageQueue,
}: ChatPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // Whether the view is at the newest messages, so it keeps them in view as the transcript changes size.
  const following = useRef(true);
  // Something new arrived at the end while the person was reading further up.
  const [unseen, setUnseen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shown = useRef<TranscriptView | null>(null);
  const mobile = Boolean(onBack);
  const focusChatId = mobile && !hidden ? chat.id : null;
  const members = chat.kind === "circle" ? chat.members : [];
  const name = chatName(chat);
  const messages = transcript?.messages ?? NO_MESSAGES;
  const timeZone = useTimeZone();
  const transcriptMessages = withDateDividers(messages, new Date(), timeZone);
  const working = status === "working";
  const attached = !transcript || isAttached(transcript);
  const targetMessageId = transcript?.targetMessageId;
  const firstMessageId = messages[0]?.id;
  const lastMessage = messages.at(-1);
  // A complete reply part followed by more work is text the Wisp wrote before
  // using a tool, so the activity indicator stays visible below it.
  const responding =
    (lastMessage?.type === "incoming" && lastMessage.status !== "complete" && Boolean(lastMessage.text.trim())) ||
    messages.some(
      (message) => message.type === "incoming" && message.status === "streaming" && Boolean(message.text.trim()),
    );
  const showActivity = attached && working && !responding;
  const openKey = transcript && !hidden ? `${chat.id}:${transcript.epoch}` : null;
  const endKey = `${lastMessage?.id}:${lastMessage && "text" in lastMessage ? lastMessage.text.length : 0}:${working}`;
  const canLoadOlder = Boolean(transcript?.olderCursor) && !transcript?.loading;
  const canLoadNewer = Boolean(transcript?.newerCursor) && !transcript?.loading;

  function handleScroll(): void {
    const element = transcriptRef.current;
    if (!element) return;
    following.current = atBottom(element);
    if (following.current) setUnseen(false);
    loadPageAtEdge();
  }

  function showLatest(): void {
    const element = transcriptRef.current;
    if (!attached || !element) {
      onShowLatest();
      return;
    }
    element.scrollTop = element.scrollHeight;
    following.current = true;
    setUnseen(false);
  }

  function loadPageAtEdge(): void {
    const element = transcriptRef.current;
    if (!element || !openKey) return;
    if (canLoadOlder && element.scrollTop <= PAGE_EDGE_DISTANCE) onLoadOlder();
    else if (canLoadNewer && element.scrollHeight - element.scrollTop - element.clientHeight <= PAGE_EDGE_DISTANCE) {
      onLoadNewer();
    }
  }

  // Runs when the transcript's content changes, not on every render: a page
  // that failed to load must not be requested again until the user scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above; the rest is read fresh on those changes.
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element || !openKey) {
      shown.current = null;
      return;
    }
    const previous = shown.current;
    if (previous?.openKey !== openKey) {
      // A window opened, or shown again: go to the message it was opened on, else to the newest.
      const target = messageElement(element, targetMessageId);
      element.scrollTop = target
        ? target.offsetTop - (element.clientHeight - target.offsetHeight) / 2
        : element.scrollHeight;
      setUnseen(false);
    } else {
      // An older page arrived above: keep the message that was first where it is.
      const anchor =
        previous.firstMessageId !== firstMessageId ? messageElement(element, previous.firstMessageId) : null;
      if (anchor) element.scrollTop += anchor.offsetTop - previous.firstMessageTop;
      // Only a change at the end of an attached window is a new message; a newer page is not.
      if (attached && previous.attached && previous.endKey !== endKey) {
        // The person's own message always shows; anything else only while they follow along.
        const sent = lastMessage?.id !== previous.lastMessageId && lastMessage?.type === "outgoing";
        if (following.current || sent) element.scrollTop = element.scrollHeight;
        else setUnseen(true);
      }
    }
    following.current = atBottom(element);
    shown.current = {
      openKey,
      endKey,
      lastMessageId: lastMessage?.id,
      attached,
      firstMessageId,
      firstMessageTop: messageElement(element, firstMessageId)?.offsetTop ?? 0,
    };
    loadPageAtEdge();
  }, [openKey, endKey, attached, firstMessageId]);

  // Content can grow without a new message (approvals, activity, images), and the
  // view can shrink (the composer, the pending bar, a mobile keyboard): either way,
  // a view that was at the newest messages stays there.
  useEffect(() => {
    const element = transcriptRef.current;
    const content = messagesRef.current;
    if (!element || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shown.current?.attached && following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (focusChatId) titleRef.current?.focus();
  }, [focusChatId]);

  return (
    <main hidden={hidden} className={cn(mainPanel, "chat-panel", hidden && "hidden")}>
      <header className="chat-header flex h-11 flex-none items-center justify-between border-b border-black/[0.035] px-3.5 dark:border-white/[0.035]">
        {onBack ? (
          <Button
            className="chat-back"
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Back to conversations"
            onClick={onBack}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
        ) : null}
        <div className="chat-heading inline-flex min-w-0 items-center gap-2 rounded-lg p-1">
          <ChatAvatar chat={chat} size="sm" />
          <div className="min-w-0">
            <h1 ref={titleRef} tabIndex={-1} className="block truncate font-semibold outline-none">
              {name}
            </h1>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {chat.kind === "circle" ? (
            <button
              className="rounded-md border-0 bg-transparent px-[7px] py-1 text-dim text-sm hover:bg-muted hover:text-foreground"
              type="button"
              aria-label={`View circle participants (${members.length})`}
              title={members.map((member) => member.name).join(", ") || "No Wisps in this circle"}
              onClick={onOpenDetails}
            >
              {members.length} {members.length === 1 ? "Wisp" : "Wisps"}
            </button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={chat.kind === "circle" ? "Open circle settings" : "Open Wisp settings"}
            title={chat.kind === "circle" ? "Circle settings" : "Wisp settings"}
            onClick={onOpenDetails}
          >
            <SettingsIcon aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Scroll anchoring is done here, so the browser's own must not also move the view. */}
        <div
          className="chat-transcript relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none [overflow-anchor:none]"
          ref={transcriptRef}
          tabIndex={0}
          aria-label={`${name} conversation`}
          onScroll={handleScroll}
        >
          <div
            ref={messagesRef}
            className="chat-messages mx-auto flex w-full max-w-[1400px] flex-col px-3.5 pt-1.5 pb-[22px]"
            role="log"
            aria-live="polite"
            aria-busy={transcript?.loading ?? true}
          >
            {transcriptMessages.map((message, index) => {
              const previous = transcriptMessages[index - 1];
              return (
                <div
                  key={message.id ?? `${chat.id}-${message.type}-${index}`}
                  className={messageRow}
                  data-message-id={message.id}
                  data-highlighted={(message.id !== undefined && message.id === targetMessageId) || undefined}
                >
                  <MessageView
                    message={message}
                    dense={message.type === "outgoing" && previous?.type === "outgoing"}
                    onAnswer={(answer) => onAnswerPrompt(message.id, answer)}
                    onRetry={() => onRetry(message.id)}
                  />
                </div>
              );
            })}
            {/* These belong to the newest messages, so a window opened elsewhere in the transcript omits them. */}
            {attached
              ? approvals.map((request) => (
                  <ToolApprovalCard
                    key={request.approvalId}
                    request={request}
                    wispName={name}
                    allowAlwaysAvailable={allowAlwaysAvailable}
                    onResolve={(decision) => onResolveApproval(request, decision)}
                  />
                ))
              : null}
            {showActivity ? (
              <div role="status" className="mt-3 flex items-center gap-2 text-dim text-sm">
                <span
                  aria-hidden="true"
                  className="flex items-center gap-1 rounded-[16px] rounded-bl-[5px] border border-border bg-bubble-in px-3.5 py-3"
                >
                  {[0, 200, 400].map((delay) => (
                    <span
                      key={delay}
                      className="size-1.5 rounded-full bg-dim animate-typing-dot motion-reduce:animate-none"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
                {activity ? <span>{activity}</span> : <span className="sr-only">{`${name} is working…`}</span>}
              </div>
            ) : null}
          </div>
        </div>
        {attached && !unseen ? null : (
          <Button
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
            variant="outline"
            size="sm"
            type="button"
            onClick={showLatest}
          >
            <ArrowDownIcon aria-hidden="true" />
            Jump to latest
          </Button>
        )}
      </div>

      {scheduledMessages?.available || messageQueue?.available ? (
        <div className="flex-none px-3">
          <PendingMessagesBar
            queued={
              messageQueue?.available
                ? messageQueue.messages.filter(({ conversationId }) => conversationId === chat.id)
                : []
            }
            scheduled={
              scheduledMessages?.available
                ? scheduledMessages.messages.filter(({ conversationId }) => conversationId === chat.id)
                : []
            }
            queue={messageQueue ?? NO_QUEUE}
            schedule={scheduledMessages ?? NO_SCHEDULE}
          />
        </div>
      ) : null}
      <ChatComposer
        key={chat.id}
        chat={chat}
        status={status}
        error={error}
        acknowledging={acknowledging}
        onConfigure={onConfigure}
        voice={voice}
        voiceShortcutEnabled={!hidden}
        onConfigureVoice={onConfigureVoice}
        onAbort={onAbort}
        onSend={onSend}
        onSchedule={
          scheduledMessages?.available ? (text, at) => scheduledMessages.schedule(chat.id, text, at) : undefined
        }
        autoFocus={!onBack && !hidden}
        enterToSend={!onBack}
        mobile={mobile}
      />
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };
