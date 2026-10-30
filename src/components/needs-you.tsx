import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import type { ChatId, ChatViewCollection } from "@/chat-data";
import { ApprovalSheet, ApprovalSummary } from "@/components/approval-summary";
import { pendingApprovals } from "@/components/mobile-approvals";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

interface NeedsYouProps {
  chats: ChatViewCollection;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  onResolve: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onOpenChat: (chatId: ChatId) => void;
  /** Opens the Approvals tab, where the rest wait; without it they are not pointed to. */
  onOpenApprovals?: () => void;
}

/**
 * The approval asked last, at the top of the mobile list, so it can be answered without opening
 * the conversation. Tapping it shows everything about the request.
 */
export function NeedsYou({ chats, approvals, onResolve, onOpenChat, onOpenApprovals }: NeedsYouProps) {
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const pending = pendingApprovals(chats, approvals);
  const request = pending[0];
  const reviewing = pending.find(({ approvalId }) => approvalId === reviewingId);
  const reviewingChat = reviewing ? chats[reviewing.conversationId] : undefined;
  if (!request && !reviewing) return null;

  const sheet =
    reviewing && reviewingChat ? (
      <ApprovalSheet
        chat={reviewingChat}
        request={reviewing}
        onResolve={(decision) => onResolve(reviewing, decision)}
        onClose={() => setReviewingId(null)}
        onOpenChat={onOpenChat}
      />
    ) : null;

  if (!request) return sheet;
  const more = pending.length - 1;

  return (
    <section className="needs-you" aria-label="Needs you">
      <ApprovalSummary
        chat={chats[request.conversationId]!}
        request={request}
        stacked={more > 0}
        onResolve={(decision) => onResolve(request, decision)}
        onReview={() => setReviewingId(request.approvalId)}
      />
      {more > 0 && onOpenApprovals ? (
        <button type="button" className="needs-you-more" onClick={onOpenApprovals}>
          {`${more} more waiting`}
          <ChevronRightIcon aria-hidden="true" />
        </button>
      ) : null}
      {sheet}
    </section>
  );
}
