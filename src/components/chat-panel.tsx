import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDownIcon, CheckIcon, ChevronLeftIcon, SettingsIcon, XIcon } from "lucide-react";

import type { ChatView, Message } from "@/chat-data";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { QueuedMessage } from "../../shared/message-queue";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { describeMcpAlias, getToolMetadata } from "../../shared/tool-catalog";
import type { ToolActivityView } from "@/lib/conversation-stream";
import { approvalWispName, chatName } from "@/lib/chat-schema";
import { conversationStarters } from "@/lib/conversation-starters";
import { withDateDividers } from "@/lib/date-dividers";
import { isAttached, type MessageWindow } from "@/lib/message-windows";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import { isNeutralColor, wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import { ChatAvatar, WispAvatar } from "@/components/chat-avatar";
import { ChatComposer, type VoiceInputSettings } from "@/components/chat-composer";
import { Button } from "@/components/ui/button";
import { MessageView } from "@/components/message-view";
import { PendingMessagesBar } from "@/components/pending-messages-bar";
import type { MessageQueueController } from "@/hooks/use-message-queue";
import type { ScheduledMessagesController } from "@/hooks/use-scheduled-messages";
import { useTimeZone } from "@/hooks/use-time-zone";
import { AllowAllApprovals, ToolApprovalCard } from "@/components/tool-approval-card";

const NO_MESSAGES: ReadonlyArray<Message> = [];
const unavailable = async () => "This server cannot do that. Update it first.";
const NO_QUEUE = { update: unavailable, cancel: unavailable };
const NO_SCHEDULE = { update: unavailable, cancel: unavailable, sendNow: unavailable };
/** How close to an end of the transcript, in pixels, the view gets before the next page loads. */
const PAGE_EDGE_DISTANCE = 120;
/** How close to the bottom, in pixels, the view still counts as following the newest messages. */
const FOLLOW_DISTANCE = 24;
/** How long after the person's last wheel, key or scroll a scroll still counts as theirs, in milliseconds. */
const SCROLL_INTENT_MS = 250;

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

/** The color a conversation takes on: its Wisp's. A circle has none. */
function chatAccentStyle(chat: ChatView): CSSProperties | undefined {
  if (chat.kind !== "wisp") return undefined;
  const color = wispColor(chat.wisp.name, chat.wisp.color);
  return wispAccentStyle(color);
}

/** How many of the turn's steps show; older ones fold into a count. */
const VISIBLE_STEPS = 4;

function stepLabel(toolName: string): string {
  return getToolMetadata(toolName)?.label ?? describeMcpAlias(toolName)?.label ?? toolName;
}

interface ChatPanelProps {
  hidden?: boolean;
  onBack?: () => void;
  chat: ChatView;
  /** The loaded part of the transcript; undefined until its first page arrives. */
  transcript: MessageWindow | undefined;
  status: ManagedConversationStatus;
  activity?: string;
  /** The tools the Wisp used in the turn it is working on. */
  steps?: ReadonlyArray<ToolActivityView>;
  error?: string;
  acknowledging: boolean;
  approvals: ReadonlyArray<ToolApprovalRequest>;
  onAnswerPrompt: (messageId: string | undefined, answer: string) => void;
  /** Stops the response; may resolve with follow-ups it never read, which go back to the composer. */
  onAbort: () => Promise<ReadonlyArray<QueuedMessage> | null> | void;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onShowLatest: () => void;
  onOpenDetails: () => void;
  /** Opens a Wisp's own conversation with its settings, from a mention of it in a circle. */
  onOpenWisp?: (wispId: string) => void;
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
  /** Starts a new topic in a Wisp; resolves with an error message, or null. */
  onNewTopic?: (conversationId: string) => Promise<string | null>;
  /** The person has no other Wisp, so an empty conversation suggests building the team first. */
  soleWisp?: boolean;
}

function ChatPanel({
  hidden = false,
  onBack,
  chat,
  transcript,
  status,
  activity,
  steps = [],
  error,
  acknowledging,
  approvals,
  onAnswerPrompt,
  onAbort,
  onLoadOlder,
  onLoadNewer,
  onShowLatest,
  onOpenDetails,
  onOpenWisp,
  onConfigure,
  voice,
  onConfigureVoice,
  onRetry,
  onResolveApproval,
  onSend,
  scheduledMessages,
  messageQueue,
  onNewTopic,
  soleWisp = false,
}: ChatPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // Whether the view keeps the newest messages in view as the transcript changes size. Only the
  // person scrolling stops it: content growing or shrinking under the view does not.
  const following = useRef(true);
  // When the person last scrolled, and whether a finger or the scrollbar is still holding the view.
  const scrollIntent = useRef({ at: Number.NEGATIVE_INFINITY, holding: false });
  // The view is away from the newest messages, so it offers a way back to them.
  const [away, setAway] = useState(false);
  // Something new arrived at the end while the person was reading further up.
  const [unseen, setUnseen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shown = useRef<TranscriptView | null>(null);
  const mobile = Boolean(onBack);
  const focusChatId = mobile && !hidden ? chat.id : null;
  const members = chat.kind === "circle" ? chat.members : [];
  // The latest handler, so the mentions, and the Markdown rendered with them, change only with the members.
  const openWisp = useRef(onOpenWisp);
  openWisp.current = onOpenWisp;
  const canOpenWisp = Boolean(onOpenWisp);
  const mentions = useMemo(
    () =>
      members.length
        ? { members, onOpenWisp: canOpenWisp ? (wispId: string) => openWisp.current?.(wispId) : undefined }
        : undefined,
    [members, canOpenWisp],
  );
  const name = chatName(chat);
  const messages = transcript?.messages ?? NO_MESSAGES;
  const timeZone = useTimeZone();
  const transcriptMessages = withDateDividers(messages, new Date(), timeZone);
  const working = status === "working";
  const attached = !transcript || isAttached(transcript);
  const targetMessageId = transcript?.targetMessageId;
  const firstMessageId = messages[0]?.id;
  const lastMessage = messages.at(-1);
  const failed = lastMessage?.type === "incoming" && lastMessage.status === "failed";
  const subline = approvals.length
    ? { tone: "approval", text: "Waiting for your approval" }
    : working
      ? { tone: "working", text: activity ?? "Working…" }
      : failed
        ? { tone: "error", text: "Couldn't reply" }
        : {
            tone: undefined,
            text: chat.kind === "wisp" ? chat.wisp.role : members.map((member) => member.name).join(", "),
          };
  const avatarState = approvals.length ? "approval" : working ? "working" : failed ? "error" : "idle";
  // A Wisp with nothing said yet introduces itself and offers first messages to send.
  const introducing =
    chat.kind === "wisp" && Boolean(transcript) && !transcript?.loading && !messages.length && !working;
  const startersReady = status === "idle" && !acknowledging;
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

  function follow(value: boolean): void {
    following.current = value;
    setAway(!value);
    if (value) setUnseen(false);
  }

  function noteScrollIntent(): void {
    scrollIntent.current.at = performance.now();
  }

  function holdScroll(): void {
    scrollIntent.current.holding = true;
    noteScrollIntent();
    window.addEventListener(
      "pointerup",
      () => {
        scrollIntent.current.holding = false;
        noteScrollIntent();
      },
      { once: true },
    );
  }

  function handleScroll(): void {
    const element = transcriptRef.current;
    if (!element) return;
    const intent = scrollIntent.current;
    const now = performance.now();
    const byPerson = intent.holding || now - intent.at <= SCROLL_INTENT_MS;
    const bottom = atBottom(element);
    if (byPerson) {
      // A scroll that keeps going, like a fling or a held key, stays theirs.
      intent.at = now;
      follow(bottom);
    } else if (bottom) {
      follow(true);
    } else if (following.current && shown.current?.attached) {
      // The view moved without the person: put the newest messages back in view.
      element.scrollTop = element.scrollHeight;
    }
    loadPageAtEdge();
  }

  function showLatest(): void {
    const element = transcriptRef.current;
    if (!attached || !element) {
      onShowLatest();
      return;
    }
    element.scrollTop = element.scrollHeight;
    follow(true);
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
      follow(atBottom(element));
      setUnseen(false);
    } else {
      // An older page arrived above: keep the message that was first where it is.
      const anchor =
        previous.firstMessageId !== firstMessageId ? messageElement(element, previous.firstMessageId) : null;
      if (anchor) element.scrollTop += anchor.offsetTop - previous.firstMessageTop;
      // Only a change at the end of an attached window is a new message; a newer page is not.
      if (attached && previous.attached && previous.endKey !== endKey) {
        // The person's own message always shows, and the view follows the reply from there;
        // anything else only while they follow along.
        const sent = lastMessage?.id !== previous.lastMessageId && lastMessage?.type === "outgoing";
        if (sent) follow(true);
        if (following.current) element.scrollTop = element.scrollHeight;
        else setUnseen(true);
      }
    }
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
    <main
      hidden={hidden}
      className={cn(mainPanel, "chat-panel relative", hidden && "hidden")}
      style={chatAccentStyle(chat)}
      data-accent={chat.kind === "wisp" || undefined}
      data-neutral-accent={
        (chat.kind === "wisp" && isNeutralColor(wispColor(chat.wisp.name, chat.wisp.color))) || undefined
      }
    >
      <div className="chat-ambient" data-tone={subline.tone} aria-hidden="true" />
      <header className="chat-header relative flex h-[52px] flex-none items-center justify-between border-b border-black/[0.035] px-3.5 dark:border-white/[0.035]">
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
          <span className="wisp-halo" data-state={avatarState}>
            <ChatAvatar chat={chat} state={avatarState === "working" ? "idle" : avatarState} />
          </span>
          <div className="min-w-0">
            <h1 ref={titleRef} tabIndex={-1} className="block truncate font-semibold leading-tight outline-none">
              {name}
            </h1>
            {subline.text ? (
              // The text truncates on its own, so the line does not clip the pulse around its dot.
              <p className="chat-subline flex min-w-0 items-center gap-1.5 text-xs" data-tone={subline.tone}>
                {subline.tone === "working" ? <span className="chat-subline-pulse" aria-hidden="true" /> : null}
                <span className="truncate">{subline.text}</span>
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button
            className="size-9 rounded-full border-0 bg-foreground/[0.06] hover:bg-foreground/[0.1] dark:hover:bg-foreground/[0.1]"
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
          onWheel={noteScrollIntent}
          onKeyDown={noteScrollIntent}
          onTouchStart={() => {
            scrollIntent.current.holding = true;
            noteScrollIntent();
          }}
          onTouchEnd={() => {
            scrollIntent.current.holding = false;
            noteScrollIntent();
          }}
          onTouchCancel={() => {
            scrollIntent.current.holding = false;
            noteScrollIntent();
          }}
          onPointerDown={(event) => {
            // Only the scrollbar is the transcript itself; a press on a message is not a scroll.
            if (event.target === event.currentTarget && event.pointerType === "mouse") holdScroll();
          }}
        >
          <div
            ref={messagesRef}
            className="chat-messages mx-auto flex w-full max-w-[1400px] flex-col px-3.5 pt-1.5 pb-[22px]"
            role="log"
            aria-live="polite"
            aria-busy={transcript?.loading ?? true}
          >
            {introducing && chat.kind === "wisp" ? (
              <section className="chat-intro" aria-label={`About ${name}`}>
                <span className="chat-intro-wisp">
                  <WispAvatar wisp={chat.wisp} size="xl" />
                </span>
                <h2>{`Hi, I'm ${name}`}</h2>
                {chat.wisp.role ? <p className="chat-intro-role">{chat.wisp.role}</p> : null}
                <ul className="chat-starters" aria-label="Suggested messages">
                  {conversationStarters({ soleWisp }).map((starter) => (
                    <li key={starter}>
                      <button type="button" disabled={!startersReady} onClick={() => onSend(starter)}>
                        {starter}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {transcriptMessages.map((message, index) => {
              const previous = transcriptMessages[index - 1];
              // In a circle each reply carries its Wisp's name and color; consecutive ones share the name.
              const author =
                message.type === "incoming" && message.authorId
                  ? members.find((member) => member.id === message.authorId)
                  : undefined;
              const previousAuthor = previous?.type === "incoming" ? previous.authorId : undefined;
              const authorColor = author ? wispColor(author.name, author.color) : undefined;
              return (
                <div
                  key={message.id ?? `${chat.id}-${message.type}-${index}`}
                  className={messageRow}
                  style={authorColor ? wispAccentStyle(authorColor) : undefined}
                  data-message-id={message.id}
                  data-highlighted={(message.id !== undefined && message.id === targetMessageId) || undefined}
                >
                  <MessageView
                    message={message}
                    dense={message.type === "outgoing" && previous?.type === "outgoing"}
                    author={author}
                    showAuthor={Boolean(author) && previousAuthor !== author?.id}
                    mentions={mentions}
                    onAnswer={(answer) => onAnswerPrompt(message.id, answer)}
                    onRetry={() => onRetry(message.id)}
                  />
                </div>
              );
            })}
            {/* These belong to the newest messages, so a window opened elsewhere in the transcript omits them. */}
            {attached ? (
              <>
                <AllowAllApprovals
                  requests={approvals}
                  onAllow={(request) => onResolveApproval(request, "allow_once")}
                />
                {approvals.map((request) => (
                  <ToolApprovalCard
                    key={request.approvalId}
                    request={request}
                    wispName={approvalWispName(chat, request)}
                    onResolve={(decision) => onResolveApproval(request, decision)}
                  />
                ))}
              </>
            ) : null}
            {attached && working && steps.length ? (
              <ol className="chat-steps" aria-label={`What ${name} has done so far`}>
                {steps.length > VISIBLE_STEPS ? (
                  <li className="chat-step" data-phase="completed">{`+${steps.length - VISIBLE_STEPS}`}</li>
                ) : null}
                {steps.slice(-VISIBLE_STEPS).map((step) => (
                  <li
                    key={step.toolCallId}
                    className="chat-step"
                    data-phase={step.phase === "completed" ? (step.isError ? "failed" : "completed") : "running"}
                  >
                    {step.phase !== "completed" ? (
                      <span className="chat-step-spinner" aria-hidden="true" />
                    ) : step.isError ? (
                      <XIcon aria-hidden="true" />
                    ) : (
                      <CheckIcon aria-hidden="true" />
                    )}
                    {stepLabel(step.toolName)}
                    {step.phase !== "completed" ? (
                      <span className="sr-only">, running</span>
                    ) : step.isError ? (
                      <span className="sr-only">, failed</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {showActivity ? (
              <div role="status" className="chat-activity mt-3 flex items-center gap-2 text-dim text-sm">
                <span
                  aria-hidden="true"
                  className="chat-activity-bubble flex items-center gap-1 rounded-[16px] rounded-bl-[5px] border border-border bg-bubble-in px-3.5 py-3"
                >
                  {[0, 200, 400].map((delay) => (
                    <span
                      key={delay}
                      className="chat-activity-dot size-1.5 rounded-full bg-dim animate-typing-dot motion-reduce:animate-none"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
                {activity ? <span>{activity}</span> : <span className="sr-only">{`${name} is working…`}</span>}
              </div>
            ) : null}
          </div>
        </div>
        {attached && !away && !unseen ? null : (
          <Button
            className="chat-jump absolute bottom-3 left-1/2 size-9 -translate-x-1/2 rounded-full bg-background shadow-md dark:bg-popover dark:hover:bg-muted"
            variant="outline"
            size="icon"
            type="button"
            aria-label={unseen ? "Jump to latest, new messages below" : "Jump to latest"}
            title="Jump to latest"
            data-unseen={unseen || undefined}
            onClick={showLatest}
          >
            <ArrowDownIcon aria-hidden="true" />
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
        onNewTopic={onNewTopic ? () => onNewTopic(chat.id) : undefined}
        autoFocus={!onBack && !hidden}
        enterToSend={!onBack}
        mobile={mobile}
      />
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };
