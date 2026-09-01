import { useEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { ArrowUpIcon, MicIcon, SettingsIcon, SquareIcon } from "lucide-react";

import type { Chat, ChatCollection } from "@/chat-data";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import type { ToolActivityView } from "@/lib/conversation-stream";
import { getCircleMembers } from "@/lib/circle-members";
import { iconButton, mainPanel } from "@/lib/ui-classes";
import { ChatAvatar } from "@/components/chat-avatar";
import { MessageView } from "@/components/message-view";
import { ToolApprovalCard } from "@/components/tool-approval-card";

interface ChatPanelProps {
  chat: Chat;
  chats: ChatCollection;
  draft: string;
  composerInputRef: RefObject<HTMLTextAreaElement | null>;
  status: ManagedConversationStatus;
  activity?: string;
  error?: string;
  acknowledging: boolean;
  approvals: ReadonlyArray<ToolApprovalRequest>;
  toolActivities: ReadonlyArray<ToolActivityView>;
  onAnswerPrompt: (messageId: string | undefined, answer: string) => void;
  onAbort: () => void;
  onDraftChange: (draft: string) => void;
  onOpenDetails: () => void;
  onRetry: (messageId: string | undefined) => void;
  onResolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function ChatPanel({
  chat,
  chats,
  draft,
  composerInputRef,
  status,
  activity,
  error,
  acknowledging,
  approvals,
  toolActivities,
  onAnswerPrompt,
  onAbort,
  onDraftChange,
  onOpenDetails,
  onRetry,
  onResolveApproval,
  onSubmit,
}: ChatPanelProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const members = getCircleMembers(chat, chats);
  const working = status === "working";
  const lastMessage = chat.messages.at(-1);
  const transcriptVersion = lastMessage && "text" in lastMessage ? lastMessage.text.length : chat.messages.length;

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [chat.id, chat.messages.length, transcriptVersion, working]);

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
          {chat.isCircle ? (
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
          <button
            className={iconButton}
            type="button"
            aria-label={chat.isCircle ? "Open circle settings" : "Open Wisp settings"}
            title={chat.isCircle ? "Circle settings" : "Wisp settings"}
            onClick={onOpenDetails}
          >
            <SettingsIcon aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none"
        ref={transcriptRef}
        tabIndex={0}
        aria-label={`${chat.name} conversation`}
      >
        <div
          className="mx-auto flex w-full max-w-[1400px] flex-col px-3.5 pt-1.5 pb-[22px]"
          role="log"
          aria-live="polite"
        >
          {chat.messages.map((message, index) => (
            <MessageView
              key={message.id ?? `${chat.id}-${message.type}-${index}`}
              message={message}
              onAnswer={(answer) => onAnswerPrompt(message.id, answer)}
              onRetry={() => onRetry(message.id)}
            />
          ))}
          {toolActivities.length ? (
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
          {approvals.map((request) => (
            <ToolApprovalCard
              key={request.approvalId}
              request={request}
              onResolve={(decision) => onResolveApproval(request, decision)}
            />
          ))}
          {working ? (
            <div className="mt-3 flex items-center gap-2 text-dim text-xs [&_svg]:animate-working-pulse">
              <ChatAvatar chat={chat} chats={chats} size="sm" />
              <span>{chat.name} is working…</span>
            </div>
          ) : null}
        </div>
      </div>

      <form className="flex-none px-3 pb-3" onSubmit={onSubmit}>
        <div className="h-[22px] pl-2.5 text-[11px] text-faint" role="status">
          {chat.isCircle
            ? "Circle conversations are not enabled yet"
            : (error ??
              activity ??
              (status === "configuration_required" ? "Configure a provider and model in Settings" : null) ??
              (acknowledging ? "Queueing your message…" : null) ??
              (working ? "Working on your request" : null))}
        </div>
        <div className="mx-auto flex min-h-[42px] w-full max-w-[1400px] items-end gap-2 rounded-[13px] border border-black/[0.07] bg-[#f0f0f0] px-2 py-[7px] transition-[border-color] duration-[120ms] focus-within:border-black/[0.16] dark:border-white/[0.07] dark:bg-[#282828] dark:focus-within:border-white/[0.16]">
          <textarea
            ref={composerInputRef}
            rows={1}
            className="max-h-[120px] min-h-[26px] flex-1 resize-none overflow-y-auto border-0 bg-transparent py-1 pl-0 pr-0 outline-none text-[#202020] leading-[18px] placeholder:text-[#707070] field-sizing-content dark:text-[#ededed] dark:placeholder:text-[#7c7c7c]"
            aria-label={`Message ${chat.name}`}
            placeholder={`Message ${chat.name}`}
            value={draft}
            disabled={chat.isCircle}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <button
            type="button"
            className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#dedede] text-[#686868] hover:bg-[#d5d5d5] hover:text-[#333333] dark:bg-[#343434] dark:text-[#999999] dark:hover:bg-[#3b3b3b] dark:hover:text-[#e4e4e4] [&_svg]:size-3.5"
            aria-label="Start voice input"
          >
            <MicIcon aria-hidden="true" />
          </button>
          {working ? (
            <button
              type="button"
              className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#202020] text-white hover:opacity-[0.85] dark:bg-[#f0f0f0] dark:text-[#161616] [&_svg]:size-3"
              aria-label="Stop response"
              onClick={onAbort}
            >
              <SquareIcon aria-hidden="true" fill="currentColor" />
            </button>
          ) : null}
          <button
            type="submit"
            className="flex size-[27px] flex-none items-center justify-center rounded-full border-0 bg-[#202020] text-white enabled:hover:opacity-[0.85] disabled:opacity-[0.35] dark:bg-[#f0f0f0] dark:text-[#161616] [&_svg]:size-3.5"
            aria-label={working ? "Queue message" : "Send message"}
            disabled={!draft.trim() || acknowledging || chat.isCircle}
          >
            <ArrowUpIcon aria-hidden="true" />
          </button>
        </div>
      </form>
    </main>
  );
}

export { ChatPanel };
export type { ChatPanelProps };

function toolLabel(toolName: string): string {
  if (toolName === "read") return "Read file";
  if (toolName === "grep" || toolName === "find") return "Search workspace";
  if (toolName === "ls") return "List files";
  if (toolName === "edit") return "Edit file";
  if (toolName === "write") return "Write file";
  return "Tool action";
}
