import { ShieldAlertIcon } from "lucide-react";

import { isWorkspaceFileCategory } from "../../shared/tool-policy";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../shared/tool-policy";
import { Button } from "@/components/ui/button";
import { useClock } from "@/hooks/use-clock";
import { cn } from "@/lib/utils";

interface ToolApprovalCardProps {
  request: ToolApprovalRequest;
  /** Display name of the Wisp that asked. */
  wispName: string;
  /** Auto-review is on, so a lasting Allow rule would take effect. */
  allowAlwaysAvailable: boolean;
  onResolve: (decision: ToolApprovalDecision) => void;
}

const ALWAYS_ALLOW_LABELS = {
  create_file: "Always allow creating files",
  modify_file: "Always allow editing files",
} as const;

function remainingLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ToolApprovalCard({ request, wispName, allowAlwaysAvailable, onResolve }: ToolApprovalCardProps) {
  const now = useClock(1_000);
  const integration = request.scope.kind === "integration";
  const skill = request.category === "save_skill" && request.scope.kind === "skill";
  const fileCategory = !integration && isWorkspaceFileCategory(request.category) ? request.category : null;
  const alwaysAllowTool = integration && request.alwaysAllowTool === true;
  const remaining = Math.max(0, Math.ceil((new Date(request.expiresAt).getTime() - now.getTime()) / 1_000));
  const expiresSoon = remaining <= 10;
  // The block action persists a global integration-scope rule; label it so the
  // scope is explicit instead of implying a per-tool block.
  const blockLabel = integration ? "Block all integration calls" : "Always block";
  return (
    <section
      className="tool-approval-card mt-2 w-[min(680px,90%)] rounded-xl border border-warning-solid/25 bg-warning-solid/[0.06] p-3"
      aria-label="Tool approval required"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 flex-none text-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <strong className="min-w-0 flex-1 text-sm">
              {skill ? "Approve skill?" : integration ? "Approve integration change?" : "Approve file change?"}
            </strong>
            {Number.isNaN(remaining) ? null : (
              <time
                className={cn("flex-none text-xs tabular-nums text-dim", expiresSoon && "font-medium text-destructive")}
                dateTime={request.expiresAt}
                title="The request is denied when the time runs out."
              >
                {remaining > 0 ? `Expires in ${remainingLabel(remaining)}` : "Expired"}
              </time>
            )}
          </div>
          <p className="my-1 break-words text-sm text-dim">{request.summary}</p>
          {skill && request.preview ? (
            <pre
              className="my-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-2 font-mono text-xs text-foreground"
              aria-label="Skill instructions"
            >
              {request.preview}
            </pre>
          ) : null}
          <small className="text-faint">
            {skill ? (
              <>
                {wispName} wants to save the skill {request.scope.display}. Once saved, it guides this Wisp's future
                replies; you can delete it in Wisp settings.
              </>
            ) : (
              <>
                {wispName} requested {request.toolName} for {request.scope.display}.{" "}
                {integration
                  ? "This action can change data in the connected service."
                  : "No file content is shown here."}
              </>
            )}
          </small>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        {skill ? null : (
          <Button type="button" size="sm" variant="ghost" onClick={() => onResolve("block")}>
            {blockLabel}
          </Button>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("deny")}>
          Deny
        </Button>
        {fileCategory && allowAlwaysAvailable ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("allow_always")}>
            {ALWAYS_ALLOW_LABELS[fileCategory]}
          </Button>
        ) : null}
        {alwaysAllowTool ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("allow_always")}>
            Always allow this tool
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={() => onResolve("allow_once")}>
          Allow once
        </Button>
      </div>
      {fileCategory && allowAlwaysAvailable ? (
        <p className="m-0 mt-2 text-right text-xs text-faint">
          Lasting rules can be changed in Settings → General → Auto-review.
        </p>
      ) : null}
      {alwaysAllowTool ? (
        <p className="m-0 mt-2 text-right text-xs text-faint">
          Always allow applies to {wispName} only and asks again if the tool changes. Remove it in Wisp settings →
          Access.
        </p>
      ) : null}
    </section>
  );
}

export { ToolApprovalCard };
export type { ToolApprovalCardProps };
