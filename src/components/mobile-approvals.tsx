import { useEffect, useRef } from "react";
import { ChevronRightIcon } from "lucide-react";

import type { ChatId, ChatViewCollection } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { MobileNavigation } from "@/components/mobile-navigation";
import { ToolApprovalCard } from "@/components/tool-approval-card";
import { chatName } from "@/lib/chat-schema";
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
  // Requests share one timeout, so the one that expires last was asked last.
  const pending = Object.values(approvals)
    .flat()
    .filter((request) => chats[request.conversationId])
    .sort((left, right) => Date.parse(right.expiresAt) - Date.parse(left.expiresAt));

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
        {pending.map((request) => {
          const chat = chats[request.conversationId]!;
          const name = chatName(chat);
          return (
            <article key={request.approvalId} className="mobile-approval" aria-label={`${name}: ${request.summary}`}>
              <button
                type="button"
                className="mobile-approval-chat"
                aria-label={`Open the conversation with ${name}`}
                onClick={() => onOpenChat(chat.id)}
              >
                <ChatAvatar chat={chat} size="sm" />
                <strong>{name}</strong>
                <ChevronRightIcon aria-hidden="true" />
              </button>
              <ToolApprovalCard
                request={request}
                wispName={name}
                allowAlwaysAvailable={allowAlwaysAvailable}
                onResolve={(decision) => onResolve(request, decision)}
              />
            </article>
          );
        })}
        {pending.length ? null : (
          <p className="mobile-list-empty" role="status">
            Nothing is waiting for you. When a Wisp asks to use a tool, it shows up here.
          </p>
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
