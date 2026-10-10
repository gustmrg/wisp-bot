import { CalendarClockIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { useTimeZone } from "@/hooks/use-time-zone";
import {
  formatScheduledTime,
  fromDateTimeLocalValue,
  schedulePresets,
  toDateTimeLocalValue,
} from "@/lib/scheduled-time";

interface ScheduleSendPickerProps {
  /** Pre-fills the custom time, e.g. when rescheduling. */
  initial?: Date;
  submitLabel?: string;
  busy?: boolean;
  onPick: (at: Date) => void;
}

/** Suggested send times and a custom date and time; picking one schedules the message. */
export function ScheduleSendPicker({
  initial,
  submitLabel = "Schedule",
  busy = false,
  onPick,
}: ScheduleSendPickerProps) {
  const timeZone = useTimeZone();
  const customId = useId();
  const [now] = useState(() => new Date());
  const [custom, setCustom] = useState(() =>
    toDateTimeLocalValue(initial ?? new Date(now.getTime() + 60 * 60_000), timeZone),
  );
  const customAt = fromDateTimeLocalValue(custom, timeZone);
  const customInPast = customAt !== null && customAt.getTime() <= Date.now();

  return (
    <div className="flex flex-col gap-0.5">
      {initial
        ? null
        : schedulePresets(now, timeZone).map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={busy}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
              onClick={() => onPick(preset.at)}
            >
              <span>{preset.label}</span>
              <span className="text-xs text-dim">{formatScheduledTime(preset.at, now, timeZone)}</span>
            </button>
          ))}
      <form
        className={initial ? "flex flex-col gap-2" : "mt-1 flex flex-col gap-2 border-t border-border px-2 pt-2.5"}
        onSubmit={(event) => {
          event.preventDefault();
          // React events cross portals, so the composer's form must not see this submit.
          event.stopPropagation();
          if (customAt && !customInPast) onPick(customAt);
        }}
      >
        <Field>
          <FieldLabel htmlFor={customId}>{initial ? "Send at" : "Custom time"}</FieldLabel>
          <Input
            id={customId}
            type="datetime-local"
            value={custom}
            min={toDateTimeLocalValue(now, timeZone)}
            aria-invalid={customInPast || undefined}
            onChange={(event) => setCustom(event.currentTarget.value)}
          />
          {customInPast ? <FieldError>Choose a time in the future.</FieldError> : null}
        </Field>
        <Button type="submit" size="sm" disabled={!customAt || customInPast || busy}>
          <CalendarClockIcon aria-hidden="true" />
          {submitLabel}
        </Button>
      </form>
    </div>
  );
}
