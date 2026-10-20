import { useId } from "react";

import type { Wisp, WispId } from "@/chat-data";
import { WispAvatar } from "@/components/chat-avatar";

interface CircleLeadPickerProps {
  /** The circle's members, in order. */
  members: ReadonlyArray<Wisp>;
  leadId: WispId | undefined;
  onChange: (leadId: WispId) => void;
}

/** Chooses which member answers the messages that mention no one (ADR 011). */
export function CircleLeadPicker({ members, leadId, onChange }: CircleLeadPickerProps) {
  const name = useId();
  const descriptionId = useId();
  if (!members.length) return null;
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={descriptionId}>
      <legend className="mb-1 p-0 text-dim text-sm font-medium">Lead</legend>
      <p id={descriptionId} className="mt-0 mb-2 text-faint text-sm">
        Answers messages that mention no one. Mention a Wisp with @ to ask it instead.
      </p>
      <div className="flex flex-col gap-1">
        {members.map((member) => (
          <label
            className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[10px] px-2 py-1 hover:bg-muted focus-within:bg-muted"
            key={member.id}
          >
            <input
              className="size-4 flex-none accent-foreground"
              type="radio"
              name={name}
              value={member.id}
              checked={member.id === leadId}
              onChange={() => onChange(member.id)}
            />
            <WispAvatar wisp={member} size="sm" />
            <span className="min-w-0 text-base [overflow-wrap:anywhere]">{member.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type { CircleLeadPickerProps };
