import { CrownIcon } from "lucide-react";
import type { ReactNode } from "react";

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
 */
export function LeadMark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Lead" })}
      title="Lead"
      className={cn("lead-mark inline-flex flex-none text-warning [&_svg]:size-full [&_svg]:fill-current", className)}
    >
      <CrownIcon aria-hidden="true" />
    </span>
  );
}

/**
 * A member's avatar, crowned when it is the circle's lead (SWE-252). The crown
 * overlays the avatar's top corner, so it never changes the avatar's size or
 * moves what is beside it.
 */
export function LeadCrown({
  lead,
  decorative = false,
  children,
}: {
  lead: boolean;
  decorative?: boolean;
  children: ReactNode;
}) {
  if (!lead) return children;
  return (
    <span className="lead-crown relative inline-flex flex-none">
      {children}
      <LeadMark className="absolute -top-1.5 -right-1.5 size-3" decorative={decorative} />
    </span>
  );
}
