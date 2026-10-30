import { useEffect, useId, useState } from "react";

import type { CircleResponder } from "../../shared/conversations";

interface CircleResponderPickerProps {
  value: CircleResponder;
  onChange: (value: CircleResponder) => void;
}

/** Whether a decision model can be used now; unknown while it loads, or on a server without them. */
function useDecisionModelReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    try {
      void window.wisp
        .getAiSettings()
        .then((result) => {
          if (!active || !result.ok) return;
          const slot = result.value.auxiliary.decision;
          setReady(Boolean(slot?.selection && !slot.unavailable));
        })
        .catch(() => undefined);
    } catch {
      // Without the app bridge there is nothing to report.
    }
    return () => {
      active = false;
    };
  }, []);
  return ready;
}

const OPTIONS: ReadonlyArray<{ value: CircleResponder; label: string }> = [
  { value: "lead", label: "Lead" },
  { value: "auto", label: "Decision model" },
];

/** Chooses who answers the messages that mention no one (ADR 011). */
export function CircleResponderPicker({ value, onChange }: CircleResponderPickerProps) {
  const name = useId();
  const descriptionId = useId();
  const ready = useDecisionModelReady();
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={descriptionId}>
      <legend className="mb-1 p-0 text-dim text-sm font-medium">Without a mention, who answers</legend>
      <p id={descriptionId} className="mt-0 mb-2 text-faint text-sm">
        The decision model chooses the Wisp best suited to the message. When it is not sure, the lead answers.
      </p>
      <div className="flex flex-col gap-1">
        {OPTIONS.map((option) => {
          // A circle whose model stopped being usable keeps its choice, and can only go back to the lead.
          const disabled = option.value === "auto" && ready !== true;
          return (
            <label
              className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[10px] px-2 py-1 hover:bg-muted focus-within:bg-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-60 has-[:disabled]:hover:bg-transparent"
              key={option.value}
            >
              <input
                className="size-4 flex-none accent-foreground"
                type="radio"
                name={name}
                value={option.value}
                checked={option.value === value}
                disabled={disabled}
                onChange={() => onChange(option.value)}
              />
              <span className="min-w-0 text-base">{option.label}</span>
            </label>
          );
        })}
      </div>
      {ready === false ? (
        <p className={value === "auto" ? "mt-2 mb-0 text-warning text-sm" : "mt-2 mb-0 text-faint text-sm"}>
          {value === "auto"
            ? "No decision model can be used now, so the lead answers. Choose one in Settings → AI Model."
            : "Choose a decision model in Settings → AI Model to use this."}
        </p>
      ) : null}
    </fieldset>
  );
}

export type { CircleResponderPickerProps };
