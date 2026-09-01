import { ShieldAlertIcon } from "lucide-react";

import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { Button } from "@/components/ui/button";

interface ToolApprovalCardProps {
  request: ToolApprovalRequest;
  onResolve: (decision: ToolApprovalDecision) => void;
}

function ToolApprovalCard({ request, onResolve }: ToolApprovalCardProps) {
  return (
    <section
      className="mt-2 w-[min(680px,90%)] rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3"
      aria-label="Tool approval required"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <strong className="block text-xs">Approve file change?</strong>
          <p className="my-1 break-words text-xs text-dim">{request.summary}</p>
          <small className="text-faint">Requested by {request.toolName}. No file content is shown here.</small>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={() => onResolve("block")}>
          Always block
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("deny")}>
          Deny
        </Button>
        <Button type="button" size="sm" onClick={() => onResolve("allow_once")}>
          Allow once
        </Button>
      </div>
    </section>
  );
}

export { ToolApprovalCard };
export type { ToolApprovalCardProps };
