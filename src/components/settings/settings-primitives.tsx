import { useEffect, useId, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SettingsGroup({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section className={className} aria-labelledby={headingId}>
      <h3 id={headingId} className="mx-0.5 mb-[7px] mt-[18px] text-[11px] font-normal text-dim">
        {label}
      </h3>
      {children}
    </section>
  );
}

export function SettingsCard({
  variant = "single",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { variant?: "single" | "stacked" }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] bg-popover [&_small]:text-[11.5px] [&_small]:text-dim [&_strong]:text-[12.5px]",
        variant === "stacked" && "divide-y divide-border",
        className,
      )}
      {...props}
    />
  );
}

export function SettingsRow({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn("settings-row flex min-h-[58px] items-center gap-3 px-3.5 py-[11px]", className)} {...props} />
  );
}

export function SettingsRowCopy({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("settings-row-copy flex min-w-0 flex-1 flex-col gap-[3px]", className)} {...props} />;
}

export function SettingsField({
  label,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"label">, "children"> & { label: ReactNode; children: ReactNode }) {
  return (
    <label className={cn("mb-3 flex flex-col gap-[5px] text-[11px] text-dim", className)} {...props}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Marks a setting or section that is visible but not available yet. */
export function SoonBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-px text-[10px] font-medium leading-4 text-dim",
        className,
      )}
    >
      Soon
    </span>
  );
}

const STATUS_TONES = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
} as const;

export type StatusTone = keyof typeof STATUS_TONES;

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", STATUS_TONES[tone])} />;
}

/**
 * Destructive action that asks for an inline confirmation before running,
 * instead of stacking a second dialog over the settings dialog.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  pendingLabel,
  pending = false,
  description,
  disabled = false,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  description: ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <Button variant="destructive" type="button" disabled={disabled || pending} onClick={() => setConfirming(true)}>
        {pending && pendingLabel ? pendingLabel : label}
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-label={label}
      className="flex w-full flex-col gap-2.5 rounded-[10px] border border-destructive/30 bg-destructive/5 p-3"
    >
      <p className="m-0 text-[11.5px] leading-relaxed">{description}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          type="button"
          disabled={disabled}
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button ref={cancelRef} variant="ghost" type="button" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
