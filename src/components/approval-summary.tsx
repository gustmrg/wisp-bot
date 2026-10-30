import { useState, type CSSProperties } from "react";
import { MessageCircleIcon } from "lucide-react";

import type { ChatId, ChatView } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { ToolApprovalCard, approvalAsk, needsReview, remainingLabel } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useClock } from "@/hooks/use-clock";
import { approvalWispName } from "@/lib/chat-schema";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

function accentStyle(chat: ChatView): CSSProperties | undefined {
  if (chat.kind !== "wisp") return undefined;
  return wispAccentStyle(wispColor(chat.wisp.name, chat.wisp.color));
}

interface ApprovalSummaryProps {
  chat: ChatView;
  request: ToolApprovalRequest;
  /** More approvals wait behind this one, so it shows the edge of another card. */
  stacked?: boolean;
  onResolve: (decision: ToolApprovalDecision) => void;
  onReview: () => void;
}

/**
 * An approval on a phone, small enough for several to fit on screen: who asks, what for, the
 * request in one or two lines, and the two answers it takes most often. Tapping it shows the rest.
 */
export function ApprovalSummary({ chat, request, stacked = false, onResolve, onReview }: ApprovalSummaryProps) {
  const now = useClock(1_000);
  const name = approvalWispName(chat, request);
  const remaining = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now.getTime()) / 1_000));
  return (
    <article
      className="approval-summary"
      data-stacked={stacked || undefined}
      aria-label={`${name}: ${request.summary}`}
      style={accentStyle(chat)}
    >
      <button
        type="button"
        className="approval-summary-details"
        aria-label={`${name} ${approvalAsk(request)}: ${request.summary}. Show details`}
        onClick={onReview}
      >
        <span className="approval-summary-title">
          <ChatAvatar chat={chat} size="sm" />
          <span className="min-w-0 flex-1 truncate">
            <strong>{name}</strong> {approvalAsk(request)}
          </span>
          {Number.isNaN(remaining) ? null : (
            <time dateTime={request.expiresAt}>{remaining > 0 ? remainingLabel(remaining) : "Expired"}</time>
          )}
        </span>
        <code className="approval-summary-request">{request.summary}</code>
      </button>
      <div className="approval-summary-actions">
        {needsReview(request) ? (
          <Button type="button" onClick={onReview}>
            Review
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={() => onResolve("deny")}>
              Deny
            </Button>
            <Button type="button" className="approval-summary-allow" onClick={() => onResolve("allow_once")}>
              Allow once
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

interface ApprovalSheetProps {
  chat: ChatView;
  request: ToolApprovalRequest;
  onResolve: (decision: ToolApprovalDecision) => void;
  onClose: () => void;
  /** Offers a way into the conversation; left out inside the conversation itself. */
  onOpenChat?: (chatId: ChatId) => void;
}

/** The whole request and every answer it can take, in a sheet from the bottom of the screen. */
export function ApprovalSheet({ chat, request, onResolve, onClose, onOpenChat }: ApprovalSheetProps) {
  const name = approvalWispName(chat, request);
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="approval-sheet" viewportClassName="approval-sheet-viewport" style={accentStyle(chat)}>
        <div className="approval-sheet-header">
          <span className="wisp-halo" data-state="approval">
            <ChatAvatar chat={chat} size="lg" state="approval" />
          </span>
          <DialogTitle className="text-md leading-snug">{`${name} ${approvalAsk(request)}`}</DialogTitle>
        </div>
        <ToolApprovalCard
          request={request}
          wispName={name}
          onResolve={(decision) => {
            onClose();
            onResolve(decision);
          }}
        />
        {onOpenChat ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onClose();
              onOpenChat(chat.id);
            }}
          >
            <MessageCircleIcon aria-hidden="true" />
            Open conversation
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ApprovalSummariesProps {
  requests: ReadonlyArray<ToolApprovalRequest>;
  chatOf: (request: ToolApprovalRequest) => ChatView;
  onResolve: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onOpenChat?: (chatId: ChatId) => void;
}

/** Several approvals, one small card each, and the sheet that shows any of them whole. */
export function ApprovalSummaries({ requests, chatOf, onResolve, onOpenChat }: ApprovalSummariesProps) {
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const reviewing = requests.find(({ approvalId }) => approvalId === reviewingId);
  return (
    <>
      {requests.map((request) => (
        <ApprovalSummary
          key={request.approvalId}
          chat={chatOf(request)}
          request={request}
          onResolve={(decision) => onResolve(request, decision)}
          onReview={() => setReviewingId(request.approvalId)}
        />
      ))}
      {reviewing ? (
        <ApprovalSheet
          chat={chatOf(reviewing)}
          request={reviewing}
          onResolve={(decision) => onResolve(reviewing, decision)}
          onClose={() => setReviewingId(null)}
          onOpenChat={onOpenChat}
        />
      ) : null}
    </>
  );
}
