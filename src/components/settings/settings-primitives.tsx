import { useEffect, useId, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function SettingsGroup({
  label,
  note,
  children,
  className,
}: {
  label: ReactNode;
  /** A remark beside the label, such as where the group is saved; not part of the group's name. */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section className={className} aria-labelledby={headingId}>
      <div className="mx-0.5 mb-[7px] mt-[18px] flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 id={headingId} className="m-0 text-xs font-normal text-dim">
          {label}
        </h3>
        {note ? <span className="text-2xs text-faint">{note}</span> : null}
      </div>
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
        "overflow-hidden rounded-[10px] bg-popover",
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

/** Title of a settings row. With `htmlFor` it labels the row's control. */
export function SettingsRowTitle({
  htmlFor,
  className,
  children,
}: {
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn("text-sm font-bold", className);
  return htmlFor ? (
    <label htmlFor={htmlFor} className={classes}>
      {children}
    </label>
  ) : (
    <span className={classes}>{children}</span>
  );
}

export function SettingsRowDescription({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return <p className={cn("m-0 text-xs leading-[1.3] text-dim", className)} {...props} />;
}

/**
 * Buttons that act on a setting: side by side at their own width on the desktop,
 * stacked across the panel on mobile.
 */
export function SettingsActions({
  align = "start",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5 max-[760px]:flex-col max-[760px]:gap-2",
        align === "end" && "justify-end",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled control with optional help text below it. The label wraps the control. */
export function SettingsField({
  label,
  description,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"label">, "children"> & {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field className={cn("mb-3", className)}>
      <FieldLabel className="flex flex-col gap-1.5" {...props}>
        <span>{label}</span>
        {children}
      </FieldLabel>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

/** Marks a setting or section that is visible but not available yet. */
export function SoonBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-px text-2xs font-medium leading-4 text-dim",
        className,
      )}
    >
      Soon
    </span>
  );
}

const STATUS_TONES = {
  success: "bg-emerald-500",
  warning: "bg-warning-solid",
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
  variant = "destructive",
  className,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  description: ReactNode;
  disabled?: boolean;
  /** How the first button looks; the confirming button is always destructive. */
  variant?: "destructive" | "outline" | "ghost";
  className?: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  if (!confirming) {
    return (
      <Button
        variant={variant}
        type="button"
        className={className}
        disabled={disabled || pending}
        onClick={() => setConfirming(true)}
      >
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
      <p className="m-0 text-xs leading-relaxed">{description}</p>
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
