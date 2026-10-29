import { CrownIcon } from "lucide-react";

import type { WispId } from "@/chat-data";
import { cn } from "@/lib/utils";
import { circleLeadId } from "../../shared/conversations";

/** The member to crown: the circle's lead, once it has more than one member to lead. */
export function crownedLeadId(memberIds: ReadonlyArray<WispId>): WispId | undefined {
  return memberIds.length > 1 ? circleLeadId({ memberIds }) : undefined;
}

/**
 * The crown that marks a circle's lead, named "Lead" for screen readers and on
 * hover. Inside a control that already says who leads, it is only decoration.
 * It is a neutral outline, so it never reads as a Wisp's color.
 */
export function LeadMark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Lead" })}
      title="Lead"
      className={cn("lead-mark inline-flex flex-none text-dim [&_svg]:size-full", className)}
    >
      <CrownIcon aria-hidden="true" />
    </span>
  );
}
