import { ChevronRightIcon, ShieldAlertIcon } from "lucide-react";

import type { ChatViewCollection } from "@/chat-data";
import { pendingApprovals } from "@/components/mobile-approvals";
import { chatName } from "@/lib/chat-schema";
import type { ToolApprovalRequest } from "../../shared/tool-policy";

interface NeedsYouProps {
  chats: ChatViewCollection;
  approvals: Record<string, ReadonlyArray<ToolApprovalRequest>>;
  onOpenApprovals: () => void;
}

/** One line at the top of the mobile list while approvals wait; they are answered on the Approvals tab (ADR 048). */
export function NeedsYou({ chats, approvals, onOpenApprovals }: NeedsYouProps) {
  const pending = pendingApprovals(chats, approvals);
  const latest = pending[0];
  if (!latest) return null;
  const label =
    pending.length === 1
      ? `${chatName(chats[latest.conversationId]!)} is waiting for your approval`
      : `${pending.length} approvals waiting`;

  return (
    <button type="button" className="needs-you" onClick={onOpenApprovals}>
      <ShieldAlertIcon aria-hidden="true" />
      <span>{label}</span>
      <ChevronRightIcon aria-hidden="true" />
    </button>
  );
}
