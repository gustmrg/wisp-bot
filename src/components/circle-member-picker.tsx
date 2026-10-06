import { Checkbox } from "@base-ui/react/checkbox";
import { CheckIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import type { ChatId, WispSummary } from "@/chat-data";
import { ChatAvatar } from "@/components/chat-avatar";

interface CircleMemberPickerProps {
  availableWisps: ReadonlyArray<WispSummary>;
  selectedIds: ReadonlyArray<ChatId>;
  onChange: (memberIds: ChatId[]) => void;
  label?: string;
}

export function CircleMemberPicker({
  availableWisps,
  selectedIds,
  onChange,
  label = "Add Wisps",
}: CircleMemberPickerProps) {
  const labelId = useId();
  const [announcement, setAnnouncement] = useState("");
  const availableById = new Map(availableWisps.map((wisp) => [wisp.id, wisp]));
  const normalizedIds = [...new Set(selectedIds)].filter((id) => availableById.has(id));
  const selectedWisps = normalizedIds.flatMap((id) => {
    const wisp = availableById.get(id);
    return wisp ? [wisp] : [];
  });

  function toggleMember(wisp: WispSummary, selected: boolean): void {
    const next = selected ? [...normalizedIds, wisp.id] : normalizedIds.filter((id) => id !== wisp.id);
    onChange(next);
    setAnnouncement(`${wisp.name} ${selected ? "added to" : "removed from"} circle.`);
  }

  return (
    <div>
      <span id={labelId} className="mb-2 block text-dim text-sm font-medium">
        {label}
      </span>
      <div className="overflow-hidden rounded-[11px] border border-border" role="group" aria-labelledby={labelId}>
        <div
          className="flex min-h-16 max-h-[132px] flex-wrap items-center gap-2 overflow-y-auto border-b border-border p-3"
          aria-label="Selected Wisps"
        >
          {selectedWisps.length ? (
            selectedWisps.map((wisp) => (
              <span
                className="inline-flex max-w-full items-center gap-[7px] rounded-full bg-muted px-[9px] py-[5px]"
                key={wisp.id}
              >
                <ChatAvatar chat={wisp} size="sm" />
                <span className="min-w-0 truncate">{wisp.name}</span>
                <button
                  className="inline-flex size-[22px] flex-none items-center justify-center rounded-full border-0 bg-transparent text-dim hover:bg-accent focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 [&_svg]:size-3.5"
                  type="button"
                  aria-label={`Remove ${wisp.name}`}
                  onClick={() => toggleMember(wisp, false)}
                >
                  <XIcon aria-hidden="true" />
                </button>
              </span>
            ))
          ) : (
            <span className="p-2 text-dim text-base">Select Wisps to add to this circle</span>
          )}
        </div>
        <div className="min-h-24 max-h-[260px] overflow-y-auto py-[3px]">
          {availableWisps.map((wisp) => (
            <label
              className="flex min-h-[46px] cursor-pointer items-center gap-3 px-3.5 py-[7px] hover:bg-muted focus-within:bg-muted"
              key={wisp.id}
            >
              <Checkbox.Root
                className="inline-flex size-5 flex-none items-center justify-center rounded-[5px] border border-border bg-background focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 data-checked:border-foreground data-checked:bg-foreground data-checked:text-background [&_svg]:size-[15px]"
                checked={normalizedIds.includes(wisp.id)}
                onCheckedChange={(checked) => toggleMember(wisp, checked)}
              >
                <Checkbox.Indicator>
                  <CheckIcon aria-hidden="true" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <ChatAvatar chat={wisp} />
              <span className="min-w-0 text-base [overflow-wrap:anywhere]">{wisp.name}</span>
            </label>
          ))}
          {!availableWisps.length ? (
            <p className="p-2 text-dim text-base">No Wisps yet. You can create an empty circle.</p>
          ) : null}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

export type { CircleMemberPickerProps };
