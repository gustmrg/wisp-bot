import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowDownIcon, ChevronLeftIcon, SettingsIcon } from "lucide-react";

import type { ChatSummary, ChatSummaryCollection, Message } from "@/chat-data";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { describeMcpAlias, getToolMetadata } from "../../shared/tool-catalog";
import type { ToolActivityView } from "@/lib/conversation-stream";
import { getCircleMembers } from "@/lib/circle-members";
import { withDateDividers } from "@/lib/date-dividers";
import { isAttached, type MessageWindow } from "@/lib/message-windows";
import { mainPanel } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import { ChatAvatar } from "@/components/chat-avatar";
import { ChatComposer } from "@/components/chat-composer";
import { Button } from "@/components/ui/button";
import { MessageView } from "@/components/message-view";
import { ToolApprovalCard } from "@/components/tool-approval-card";

const NO_MESSAGES: ReadonlyArray<Message> = [];
/** How close to an end of the transcript, in pixels, the view gets before the next page loads. */
const PAGE_EDGE_DISTANCE = 120;

// The flash is drawn over the row, centered on the message rather than on the margin above it.
const messageRow =
  "relative data-[highlighted=true]:after:pointer-events-none data-[highlighted=true]:after:absolute data-[highlighted=true]:after:-inset-x-2 data-[highlighted=true]:after:top-1.5 data-[highlighted=true]:after:-bottom-1.5 data-[highlighted=true]:after:animate-message-highlight data-[highlighted=true]:after:rounded-lg";

/** What the last layout showed, to tell a new message from an older page or a newly opened window. */
interface TranscriptView {
  openKey: string;
  endKey: string;
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

interface ChatPanelProps {
  hidden?: boolean;
  onBack?: () => void;
  chat: ChatSummary;
  chats: ChatSummaryCollection;
  /** The loaded part of the transcript; undefined until its first page arrives. */
  transcript: MessageWindow | undefined;
  status: ManagedConversationStatus;
  activity?: string;
  error?: string;
  acknowledging: boolean;
  approvals: ReadonlyArray<ToolApprovalRequest>;
  /** Auto-review is on, so approvals can offer a lasting Allow rule. */
  allowAlwaysAvailable?: boolean;
  toolActivities: ReadonlyArray<ToolActivityView>;
  onAnswerPrompt: (messageId: string | undefined, answer: string) => void;
  onAbort: () => void;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onShowLatest: () => void;
  onOpenDetails: () => void;
  onConfigure?: () => void;
  onRetry: (messageId: string | undefined) => void;
  onResolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onSend: (text: string) => void;
}

function ChatPanel({
  hidden = false,
  onBack,
  chat,
  chats,
  transcript,
  status,
  activity,
  error,
  acknowledging,
  approvals,
  allowAlwaysAvailable = false,
  toolActivities,
  onAnswerPrompt,
  onAbort,
  onLoadOlder,
  onLoadNewer,
  onShowLatest,
  onOpenDetails,
  onConfigure,
  onRetry,
  onResolveApproval,
  onSend,
}: ChatPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shown = useRef<TranscriptView | null>(null);
  const mobile = Boolean(onBack);
  const focusChatId = mobile && !hidden ? chat.id : null;
  const members = getCircleMembers(chat, chats);
  const messages = transcript?.messages ?? NO_MESSAGES;
  const transcriptMessages = withDateDividers(messages);
  const working = status === "working";
  const attached = !transcript || isAttached(transcript);
  const targetMessageId = transcript?.targetMessageId;
  const firstMessageId = messages[0]?.id;
  const lastMessage = messages.at(-1);
  const openKey = transcript && !hidden ? `${chat.id}:${transcript.epoch}` : null;
  const endKey = `${lastMessage?.id}:${lastMessage && "text" in lastMessage ? lastMessage.text.length : 0}:${working}`;
  const canLoadOlder = Boolean(transcript?.olderCursor) && !transcript?.loading;
  const canLoadNewer = Boolean(transcript?.newerCursor) && !transcript?.loading;

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
    } else {
      // An older page arrived above: keep the message that was first where it is.
      const anchor =
        previous.firstMessageId !== firstMessageId ? messageElement(element, previous.firstMessageId) : null;
      if (anchor) element.scrollTop += anchor.offsetTop - previous.firstMessageTop;
      // Only a change at the end of an attached window is a new message; a newer page is not.
      if (attached && previous.attached && previous.endKey !== endKey) element.scrollTop = element.scrollHeight;
    }
    shown.current = {
      openKey,
      endKey,
      attached,
      firstMessageId,
      firstMessageTop: messageElement(element, firstMessageId)?.offsetTop ?? 0,
    };
    loadPageAtEdge();
  }, [openKey, endKey, attached, firstMessageId]);

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
          <ChatAvatar chat={chat} chats={chats} size="sm" />
          <div className="min-w-0">
            <h1 ref={titleRef} tabIndex={-1} className="block truncate font-semibold outline-none">
              {chat.name}
            </h1>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {chat.kind === "circle" ? (
            <button
              className="rounded-md border-0 bg-transparent px-[7px] py-1 text-dim text-xs hover:bg-muted hover:text-foreground"
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
          aria-label={`${chat.name} conversation`}
          onScroll={loadPageAtEdge}
        >
          <div
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
            {attached && toolActivities.length ? (
              <ol className="my-2 flex list-none flex-col gap-1 p-0" aria-label="Recent tool activity">
                {toolActivities.map((tool) => (
                  <li key={tool.toolCallId} className="flex items-center gap-2 text-[11px] text-faint">
                    <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                    <span>
                      {toolLabel(tool.toolName)} —{" "}
                      {tool.phase === "completed" ? (tool.isError ? "failed" : "completed") : "running"}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
            {attached
              ? approvals.map((request) => (
                  <ToolApprovalCard
                    key={request.approvalId}
                    request={request}
                    wispName={chat.name}
                    allowAlwaysAvailable={allowAlwaysAvailable}
                    onResolve={(decision) => onResolveApproval(request, decision)}
                  />
                ))
              : null}
            {attached && working ? (
              <div className="mt-3 flex items-center gap-2 text-dim text-xs [&_svg]:animate-working-pulse">
                <ChatAvatar chat={chat} chats={chats} size="sm" />
                <span>{chat.name} is working…</span>
              </div>
            ) : null}
          </div>
        </div>
        {attached ? null : (
          <Button
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
            variant="outline"
            size="sm"
            type="button"
            onClick={onShowLatest}
          >
            <ArrowDownIcon aria-hidden="true" />
            Jump to latest
          </Button>
        )}
      </div>

      <ChatComposer
        key={chat.id}
        chat={chat}
        status={status}
        activity={activity}
        error={error}
        acknowledging={acknowledging}
        onConfigure={onConfigure}
        onAbort={onAbort}
        onSend={onSend}
        autoFocus={!onBack && !hidden}
        enterToSend={!onBack}
      />
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };

function toolLabel(toolName: string): string {
  return getToolMetadata(toolName)?.label ?? describeMcpAlias(toolName)?.label ?? "Tool action";
}
