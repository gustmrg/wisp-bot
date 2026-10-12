import { useEffect, useRef, type CSSProperties } from "react";
import { ChevronRightIcon } from "lucide-react";

import type { ChatId, ChatView, ChatViewCollection } from "@/chat-data";
import { ChatAvatar, WispAvatar } from "@/components/chat-avatar";
import { MobileNavigation } from "@/components/mobile-navigation";
import { ToolApprovalCard, approvalAsk } from "@/components/tool-approval-card";
import { chatName } from "@/lib/chat-schema";
import { inkOn, wispColor } from "@/lib/wisp-appearance";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

interface MobileApprovalsProps {
  chats: ChatViewCollection;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  /** Auto-review is on, so a lasting Allow rule would take effect. */
  allowAlwaysAvailable: boolean;
  unreadCount: number;
  onResolve: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onOpenChat: (chatId: ChatId) => void;
  onConversations: () => void;
  onSettings: () => void;
}

/** Every pending approval in conversations that still exist, the latest first. */
export function pendingApprovals(
  chats: ChatViewCollection,
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>,
): ToolApprovalRequest[] {
  // Requests share one timeout, so the one that expires last was asked last.
  return Object.values(approvals)
    .flat()
    .filter((request) => chats[request.conversationId])
    .sort((left, right) => Date.parse(right.expiresAt) - Date.parse(left.expiresAt));
}

interface ApprovalEntryProps {
  chat: ChatView;
  request: ToolApprovalRequest;
  allowAlwaysAvailable: boolean;
  onResolve: (decision: ToolApprovalDecision) => void;
  onOpenChat: (chatId: ChatId) => void;
}

/** One pending approval, in a card lit by the Wisp that asked, with a way into its conversation. */
export function ApprovalEntry({ chat, request, allowAlwaysAvailable, onResolve, onOpenChat }: ApprovalEntryProps) {
  const name = chatName(chat);
  const color = chat.kind === "wisp" ? wispColor(chat.wisp.name, chat.wisp.color) : undefined;
  return (
    <article
      className="mobile-approval"
      aria-label={`${name}: ${request.summary}`}
      style={color ? ({ "--wisp": color, "--wisp-ink": inkOn(color) } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="mobile-approval-chat"
        aria-label={`Open the conversation with ${name}`}
        onClick={() => onOpenChat(chat.id)}
      >
        <span className="wisp-halo">
          <ChatAvatar chat={chat} size="sm" />
        </span>
        <span className="mobile-approval-who">
          <strong>{name}</strong>
          <small>{approvalAsk(request)}</small>
        </span>
        <ChevronRightIcon aria-hidden="true" />
      </button>
      <ToolApprovalCard
        request={request}
        wispName={name}
        allowAlwaysAvailable={allowAlwaysAvailable}
        onResolve={onResolve}
      />
    </article>
  );
}

/** Every pending tool approval in one place, for the mobile Approvals tab (ADR 015). */
export function MobileApprovals({
  chats,
  approvals,
  allowAlwaysAvailable,
  unreadCount,
  onResolve,
  onOpenChat,
  onConversations,
  onSettings,
}: MobileApprovalsProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const pending = pendingApprovals(chats, approvals);
  // With nothing to answer, one of the Wisps keeps the empty screen company.
  const resting = Object.values(chats).find((chat) => chat.kind === "wisp")?.wisp;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <section className="mobile-approvals" aria-labelledby="mobile-approvals-title">
      <header className="mobile-list-header">
        <div>
          <h1 id="mobile-approvals-title" ref={titleRef} tabIndex={-1}>
            Approvals
          </h1>
          <p>{pending.length ? `${pending.length} waiting for you` : "Tools your Wisps ask to use"}</p>
        </div>
      </header>
      <div className="mobile-approvals-list">
        {pending.map((request) => (
          <ApprovalEntry
            key={request.approvalId}
            chat={chats[request.conversationId]!}
            request={request}
            allowAlwaysAvailable={allowAlwaysAvailable}
            onResolve={(decision) => onResolve(request, decision)}
            onOpenChat={onOpenChat}
          />
        ))}
        {pending.length ? null : (
          <div className="mobile-approvals-empty" role="status">
            {resting ? (
              <span className="wisp-halo">
                <WispAvatar wisp={resting} size="lg" />
              </span>
            ) : null}
            <p>
              <strong>All clear.</strong> Nothing is waiting for you. When a Wisp asks to use a tool, it shows up here.
            </p>
          </div>
        )}
      </div>
      <MobileNavigation
        current="approvals"
        onConversations={onConversations}
        onApprovals={() => titleRef.current?.focus()}
        onSettings={onSettings}
        unreadCount={unreadCount}
        approvalCount={pending.length}
      />
    </section>
  );
}
