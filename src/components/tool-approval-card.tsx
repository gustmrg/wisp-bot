import { useState } from "react";
import { ShieldAlertIcon } from "lucide-react";

import { toolDisplayLabel } from "../../shared/tool-catalog";
import { isWorkspaceFileCategory } from "../../shared/tool-policy";
import type {
  JobApprovalDetails,
  ToolApprovalDecision,
  ToolApprovalRequest,
  WispApprovalDetails,
} from "../../shared/tool-policy";
import { useTimeFormat, useTimeZone } from "@/hooks/use-time-zone";
import { clockTimeOptions } from "@/lib/clock-time";
import { Button } from "@/components/ui/button";
import { useClock } from "@/hooks/use-clock";
import { cn } from "@/lib/utils";

interface ToolApprovalCardProps {
  request: ToolApprovalRequest;
  /** Display name of the Wisp that asked. */
  wispName: string;
  onResolve: (decision: ToolApprovalDecision) => void;
}

const ALWAYS_ALLOW_LABELS = {
  create_file: "Always allow creating files",
  modify_file: "Always allow editing files",
} as const;

/** What a Wisp is asking for, to follow its name: "Atlas wants to edit a file". */
function approvalAsk(request: ToolApprovalRequest): string {
  switch (request.category) {
    case "create_file":
      return "wants to create a file";
    case "modify_file":
      return "wants to edit a file";
    case "save_skill":
      return "wants to save a skill";
    case "save_memory":
      return "wants to change its memory";
    case "schedule_job":
      return "wants to schedule a job";
    case "manage_wisp":
      return request.wisp?.action === "delete"
        ? "wants to delete a Wisp"
        : request.wisp?.action === "update"
          ? "wants to change a Wisp"
          : "wants to create a Wisp";
    case "container_command":
    case "shell":
      return "wants to run a command";
    case "browser":
    case "browser_submit":
      return `wants to act on ${request.scope.display}`;
    case "external_write":
    case "integration_call":
      return `wants to use ${request.scope.display}`;
    default:
      return "asks for your approval";
  }
}

/** Jobs, skills, memory and Wisp changes are read in full before they are approved, so they have no one-tap answer. */
function needsReview(request: ToolApprovalRequest): boolean {
  return (
    request.category === "save_skill" ||
    request.category === "save_memory" ||
    request.category === "schedule_job" ||
    request.category === "manage_wisp"
  );
}

function remainingLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Everything a job may do while no one is present, as its approval card shows it (ADR 019). */
function JobDetails({ job }: { job: JobApprovalDetails }) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const nextRun = job.nextRunAt
    ? new Date(job.nextRunAt).toLocaleString([], {
        timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        ...clockTimeOptions(timeFormat),
      })
    : "None";
  const tools = job.tools.map(toolDisplayLabel);
  return (
    <dl className="my-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <dt className="text-dim">Job</dt>
      <dd className="m-0 break-words font-medium">{job.title}</dd>
      <dt className="text-dim">Schedule</dt>
      <dd className="m-0 break-words">{job.schedule}</dd>
      <dt className="text-dim">Next run</dt>
      <dd className="m-0">{nextRun}</dd>
      <dt className="text-dim">Tools</dt>
      <dd className="m-0 break-words">{tools.length ? tools.join(", ") : "None"}</dd>
      <dt className="text-dim">Skills</dt>
      <dd className="m-0 break-words">{job.skills.length ? job.skills.join(", ") : "None"}</dd>
      <dt className="col-span-2 mt-1 text-dim">Instructions</dt>
      <dd className="col-span-2 m-0">
        <pre
          className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-2 font-mono text-xs text-foreground"
          aria-label="Job instructions"
        >
          {job.instructions}
        </pre>
      </dd>
    </dl>
  );
}

/** The Wisp to create, change or delete, as its approval card shows it (ADR 024). */
function WispDetails({ wisp }: { wisp: WispApprovalDetails }) {
  const changes = wisp.changes ?? {};
  return (
    <dl className="my-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <dt className="text-dim">Wisp</dt>
      <dd className="m-0 break-words font-medium">{wisp.name}</dd>
      {changes.name !== undefined && wisp.action === "update" ? (
        <>
          <dt className="text-dim">New name</dt>
          <dd className="m-0 break-words">{changes.name}</dd>
        </>
      ) : null}
      {changes.role !== undefined ? (
        <>
          <dt className="text-dim">{wisp.action === "update" ? "New role" : "Role"}</dt>
          <dd className="m-0 break-words">{changes.role || "None"}</dd>
        </>
      ) : null}
      {changes.soul !== undefined ? (
        <>
          <dt className="col-span-2 mt-1 text-dim">{wisp.action === "update" ? "New soul" : "Soul"}</dt>
          <dd className="col-span-2 m-0">
            <pre
              className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-2 font-mono text-xs text-foreground"
              aria-label="Wisp soul"
            >
              {changes.soul || "(empty)"}
            </pre>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function ToolApprovalCard({ request, wispName, onResolve }: ToolApprovalCardProps) {
  const now = useClock(1_000);
  const integration = request.scope.kind === "integration";
  const skill = request.category === "save_skill" && request.scope.kind === "skill";
  const memory = request.category === "save_memory" && request.scope.kind === "memory";
  const job = request.category === "schedule_job" && request.scope.kind === "job" ? request.job : undefined;
  const wisp = request.category === "manage_wisp" && request.scope.kind === "wisp" ? request.wisp : undefined;
  // Skills, memory, jobs and Wisp changes are approved one at a time; no lasting rule covers them.
  const reviewed = skill || memory || Boolean(job) || Boolean(wisp);
  const fileCategory = !integration && isWorkspaceFileCategory(request.category) ? request.category : null;
  const alwaysAllowTool = integration && request.alwaysAllowTool === true;
  const alwaysAllowIntegration = integration && request.alwaysAllowIntegration === true;
  const remaining = Math.max(0, Math.ceil((new Date(request.expiresAt).getTime() - now.getTime()) / 1_000));
  const expiresSoon = remaining <= 10;
  // An integration block persists a global integration-scope rule; label it so
  // the scope is explicit instead of implying a per-tool block. File blocks are per Wisp.
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
              {wisp
                ? wisp.action === "delete"
                  ? `Delete ${wisp.name}?`
                  : wisp.action === "update"
                    ? "Approve Wisp change?"
                    : "Approve new Wisp?"
                : job
                  ? "Approve job?"
                  : skill
                    ? "Approve skill?"
                    : memory
                      ? "Save to memory?"
                      : integration
                        ? "Approve integration change?"
                        : request.category === "shell" || request.category === "container_command"
                          ? "Approve command?"
                          : request.category === "browser" || request.category === "browser_submit"
                            ? "Approve browser action?"
                            : "Approve file change?"}
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
          {job ? (
            <JobDetails job={job} />
          ) : wisp && wisp.action !== "delete" ? (
            <WispDetails wisp={wisp} />
          ) : (
            <p className="my-1 break-words text-sm text-dim">{request.summary}</p>
          )}
          {(skill || memory) && request.preview ? (
            <pre
              className="my-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-2 font-mono text-xs text-foreground"
              aria-label={memory ? "Memory changes" : "Skill instructions"}
            >
              {request.preview}
            </pre>
          ) : null}
          <small className="text-faint">
            {wisp ? (
              wisp.action === "delete" ? (
                <>
                  {wispName} wants to permanently delete {wisp.name}, including its conversation history and settings.
                  This action cannot be undone.
                </>
              ) : wisp.action === "update" ? (
                <>{wisp.name} follows these changes from its next message. You can edit it again in its settings.</>
              ) : (
                <>The new Wisp gets its own conversation. You can edit or delete it in its settings.</>
              )
            ) : job ? (
              <>
                {wispName} will run this job in the background with no one present, using only these tools, and send you
                its results here. You can pause or delete it in Settings → Jobs.
              </>
            ) : memory ? (
              <>
                Memory is part of every request
                {request.scope.display.startsWith("About you") ? ", and every Wisp sees what is about you" : ""}. You
                can edit or remove entries in Wisp settings → Memory.
              </>
            ) : skill ? (
              <>
                {wispName} wants to save the skill {request.scope.display}. Once saved, it guides this Wisp's future
                replies; you can delete it in Wisp settings.
              </>
            ) : (
              <>
                {wispName} requested {request.toolLabel ?? toolDisplayLabel(request.toolName)} for{" "}
                {request.scope.display}.{" "}
                {integration
                  ? "This action can change data in the connected service."
                  : request.category === "browser_submit"
                    ? "This can send what the Wisp typed, or act on your behalf, on that site."
                    : fileCategory
                      ? "No file content is shown here."
                      : ""}
              </>
            )}
          </small>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        {reviewed ? null : (
          <Button type="button" size="sm" variant="ghost" onClick={() => onResolve("block")}>
            {blockLabel}
          </Button>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("deny")}>
          Deny
        </Button>
        {fileCategory ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("allow_always")}>
            {ALWAYS_ALLOW_LABELS[fileCategory]}
          </Button>
        ) : null}
        {alwaysAllowTool ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("allow_always")}>
            Always allow this tool
          </Button>
        ) : null}
        {alwaysAllowIntegration ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onResolve("allow_integration")}>
            Always allow all of {request.scope.display}
          </Button>
        ) : null}
        {wisp?.action === "delete" ? (
          <Button type="button" size="sm" variant="destructive" onClick={() => onResolve("allow_once")}>
            Confirm deletion
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => onResolve("allow_once")}>
            {wisp ? (wisp.action === "create" ? "Create" : "Apply changes") : "Allow once"}
          </Button>
        )}
      </div>
      {fileCategory ? (
        <p className="m-0 mt-2 text-right text-xs text-faint">
          Always allow and Always block apply to {wispName} only. Change them in Wisp settings → Access.
        </p>
      ) : null}
      {alwaysAllowTool || alwaysAllowIntegration ? (
        <p className="m-0 mt-2 text-right text-xs text-faint">
          Always allow applies to {wispName} only
          {request.category === "integration_call" ? "; a single tool asks again if it changes" : ""}. Remove it in Wisp
          settings → Access.
        </p>
      ) : null}
    </section>
  );
}

interface AllowAllApprovalsProps {
  requests: ReadonlyArray<ToolApprovalRequest>;
  onAllow: (request: ToolApprovalRequest) => void;
}

/**
 * Allows once, in one tap, every waiting approval a tap may answer. Skills and jobs still
 * need their own review, so they are left to their cards.
 */
function AllowAllApprovals({ requests, onAllow }: AllowAllApprovalsProps) {
  // The ones already answered from here, until they leave the list.
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const allowable = requests.filter((request) => !needsReview(request) && !sent.has(request.approvalId));
  if (allowable.length < 2) return null;
  const reviews = requests.filter(needsReview).length;
  return (
    <div className="allow-all-approvals mt-2 flex w-[min(680px,90%)] items-center gap-3 rounded-xl border border-warning-solid/25 bg-warning-solid/[0.06] py-2 pr-2 pl-3">
      <span className="min-w-0 flex-1 text-sm">
        {`${allowable.length} approvals waiting`}
        {reviews ? (
          <span className="text-dim">{` · ${reviews} ${reviews === 1 ? "needs" : "need"} a review`}</span>
        ) : null}
      </span>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setSent(new Set([...sent, ...allowable.map(({ approvalId }) => approvalId)]));
          for (const request of allowable) onAllow(request);
        }}
      >
        {`Allow all ${allowable.length} once`}
      </Button>
    </div>
  );
}

export { AllowAllApprovals, ToolApprovalCard, approvalAsk, needsReview, remainingLabel };
export type { ToolApprovalCardProps };
