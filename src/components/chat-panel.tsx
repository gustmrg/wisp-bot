import { useEffect, useRef } from "react";
import { SettingsIcon } from "lucide-react";

import type { Chat, ChatCollection } from "@/chat-data";
import type { ManagedConversationStatus } from "../../shared/conversations";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import type { ToolActivityView } from "@/lib/conversation-stream";
import { getCircleMembers } from "@/lib/circle-members";
import { mainPanel } from "@/lib/ui-classes";
import { ChatAvatar } from "@/components/chat-avatar";
import { ChatComposer } from "@/components/chat-composer";
import { Button } from "@/components/ui/button";
import { MessageView } from "@/components/message-view";
import { ToolApprovalCard } from "@/components/tool-approval-card";

interface ChatPanelProps {
  chat: Chat;
  chats: ChatCollection;
  status: ManagedConversationStatus;
  activity?: string;
  error?: string;
  acknowledging: boolean;
  approvals: ReadonlyArray<ToolApprovalRequest>;
  toolActivities: ReadonlyArray<ToolActivityView>;
  onAnswerPrompt: (messageId: string | undefined, answer: string) => void;
  onAbort: () => void;
  onOpenDetails: () => void;
  onRetry: (messageId: string | undefined) => void;
  onResolveApproval: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onSend: (text: string) => void;
}

function ChatPanel({
  chat,
  chats,
  status,
  activity,
  error,
  acknowledging,
  approvals,
  toolActivities,
  onAnswerPrompt,
  onAbort,
  onOpenDetails,
  onRetry,
  onResolveApproval,
  onSend,
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

  return (
    <main className={mainPanel}>
      <header className="flex h-11 flex-none items-center justify-between border-b border-black/[0.035] px-3.5 dark:border-white/[0.035]">
        <div className="inline-flex min-w-0 items-center gap-2 rounded-lg p-1">
          <ChatAvatar chat={chat} chats={chats} size="sm" />
          <span className="truncate font-semibold">{chat.name}</span>
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

      <ChatComposer
        key={chat.id}
        chat={chat}
        status={status}
        activity={activity}
        error={error}
        acknowledging={acknowledging}
        onAbort={onAbort}
        onSend={onSend}
      />
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
