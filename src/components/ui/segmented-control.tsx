import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

/** A compact single-choice control for a few short, mutually exclusive options. */
function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const group = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);

  // The indicator follows the selected option's measured box, since labels
  // have different widths; re-measure when the control resizes (fonts, layout).
  useLayoutEffect(() => {
    function measure() {
      const button = buttons.current[selectedIndex];
      setIndicator(button ? { left: button.offsetLeft, width: button.offsetWidth } : null);
    }
    measure();
    if (typeof ResizeObserver === "undefined" || !group.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(group.current);
    return () => observer.disconnect();
  }, [selectedIndex]);
  // Skip the slide on the first placement so the indicator does not sweep in from the left edge.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (indicator) placed.current = true;
  }, [indicator]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || disabled) return;
    event.preventDefault();
    const current = Math.max(0, selectedIndex);
    const next = (current + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    buttons.current[next]?.focus();
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="segmented-control"
      onKeyDown={handleKeyDown}
      className={cn("relative inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          data-slot="segmented-control-indicator"
          style={{ width: indicator.width, translate: `${indicator.left}px 0` }}
          className={cn(
            "pointer-events-none absolute inset-y-0.5 left-0 rounded-md bg-background shadow-sm dark:bg-input/30",
            placed.current && "transition-[translate,width] duration-200 ease-out",
            disabled && "opacity-50",
          )}
        />
      ) : null}
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className="relative h-6 rounded-md px-2.5 text-[11.5px] font-medium whitespace-nowrap text-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-foreground/60 aria-checked:text-foreground dark:text-muted-foreground dark:hover:text-foreground dark:disabled:hover:text-muted-foreground dark:aria-checked:text-foreground"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export { SegmentedControl };
export type { SegmentedOption, SegmentedControlProps };
