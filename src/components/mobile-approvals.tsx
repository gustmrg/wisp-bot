import { useEffect, useRef } from "react";

import type { ChatId, ChatViewCollection } from "@/chat-data";
import { ApprovalSummaries } from "@/components/approval-summary";
import { WispAvatar } from "@/components/chat-avatar";
import { MobileNavigation } from "@/components/mobile-navigation";
import { AllowAllApprovals, type ApprovalAnswer } from "@/components/tool-approval-card";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

interface MobileApprovalsProps {
  chats: ChatViewCollection;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  unreadCount: number;
  onResolve: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => ApprovalAnswer;
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

/** Every pending tool approval in one place, for the mobile Approvals tab (ADR 015). */
export function MobileApprovals({
  chats,
  approvals,
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
        <ApprovalSummaries
          requests={pending}
          chatOf={(request) => chats[request.conversationId]!}
          onResolve={onResolve}
          onOpenChat={onOpenChat}
        />
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
      <AllowAllApprovals requests={pending} onAllow={(request) => onResolve(request, "allow_once")} />
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
