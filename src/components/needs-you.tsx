import { useState, type CSSProperties } from "react";
import { ChevronRightIcon, MessageCircleIcon } from "lucide-react";

import type { ChatId, ChatView, ChatViewCollection } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";
import { pendingApprovals } from "@/components/mobile-approvals";
import { ToolApprovalCard, approvalAsk, needsReview, remainingLabel } from "@/components/tool-approval-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useClock } from "@/hooks/use-clock";
import { chatName } from "@/lib/chat-schema";
import { wispAccentStyle, wispColor } from "@/lib/wisp-appearance";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";

interface NeedsYouProps {
  chats: ChatViewCollection;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  /** Auto-review is on, so a lasting Allow rule would take effect. */
  allowAlwaysAvailable: boolean;
  onResolve: (request: ToolApprovalRequest, decision: ToolApprovalDecision) => void;
  onOpenChat: (chatId: ChatId) => void;
  /** Opens the Approvals tab, where the rest wait; without it they are not pointed to. */
  onOpenApprovals?: () => void;
}

function accentStyle(chat: ChatView): CSSProperties | undefined {
  if (chat.kind !== "wisp") return undefined;
  const color = wispColor(chat.wisp.name, chat.wisp.color);
  return wispAccentStyle(color);
}

/**
 * The approval waiting longest for the person, at the top of the mobile list, so it can be
 * answered without opening the conversation. Tapping it shows everything about the request.
 */
export function NeedsYou({
  chats,
  approvals,
  allowAlwaysAvailable,
  onResolve,
  onOpenChat,
  onOpenApprovals,
}: NeedsYouProps) {
  const now = useClock(1_000);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const pending = pendingApprovals(chats, approvals);
  const request = pending[0];
  const reviewing = pending.find(({ approvalId }) => approvalId === reviewingId);
  const reviewingChat = reviewing ? chats[reviewing.conversationId] : undefined;
  if (!request && !reviewing) return null;

  const sheet =
    reviewing && reviewingChat ? (
      <Dialog open onOpenChange={(open) => (open ? null : setReviewingId(null))}>
        <DialogContent
          className="approval-sheet"
          viewportClassName="approval-sheet-viewport"
          style={accentStyle(reviewingChat)}
        >
          <div className="approval-sheet-header">
            <span className="wisp-halo" data-state="approval">
              <ChatAvatar chat={reviewingChat} size="lg" state="approval" />
            </span>
            <DialogTitle className="text-md leading-snug">
              {`${chatName(reviewingChat)} ${approvalAsk(reviewing)}`}
            </DialogTitle>
          </div>
          <ToolApprovalCard
            request={reviewing}
            wispName={chatName(reviewingChat)}
            allowAlwaysAvailable={allowAlwaysAvailable}
            onResolve={(decision) => {
              setReviewingId(null);
              onResolve(reviewing, decision);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setReviewingId(null);
              onOpenChat(reviewingChat.id);
            }}
          >
            <MessageCircleIcon aria-hidden="true" />
            Open conversation
          </Button>
        </DialogContent>
      </Dialog>
    ) : null;

  if (!request) return sheet;
  const chat = chats[request.conversationId]!;
  const name = chatName(chat);
  const remaining = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now.getTime()) / 1_000));
  const more = pending.length - 1;

  return (
    <section className="needs-you" aria-label="Needs you" style={accentStyle(chat)}>
      <div className="needs-you-card" data-stacked={more > 0 || undefined}>
        <button
          type="button"
          className="needs-you-summary"
          aria-label={`${name} ${approvalAsk(request)}: ${request.summary}. Show details`}
          onClick={() => setReviewingId(request.approvalId)}
        >
          <span className="needs-you-title">
            <ChatAvatar chat={chat} size="sm" />
            <span className="min-w-0 flex-1 truncate">
              <strong>{name}</strong> {approvalAsk(request)}
            </span>
            {Number.isNaN(remaining) ? null : (
              <time dateTime={request.expiresAt}>{remaining > 0 ? remainingLabel(remaining) : "Expired"}</time>
            )}
          </span>
          <code className="needs-you-detail">{request.summary}</code>
        </button>
        <div className="needs-you-actions">
          {needsReview(request) ? (
            <Button type="button" onClick={() => setReviewingId(request.approvalId)}>
              Review
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={() => onResolve(request, "deny")}>
                Deny
              </Button>
              <Button type="button" className="needs-you-allow" onClick={() => onResolve(request, "allow_once")}>
                Allow once
              </Button>
            </>
          )}
        </div>
      </div>
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
