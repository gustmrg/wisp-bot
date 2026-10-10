import * as React from "react";

import { cn } from "@/lib/utils";

/** Stacks fields with the same vertical rhythm. */
function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("flex flex-col gap-4", className)} {...props} />;
}

/**
 * One setting: its label, control, and help text. Vertical fields stack them;
 * horizontal ones put the copy beside the control, as for a switch.
 */
function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & { orientation?: "vertical" | "horizontal" }) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        "flex",
        orientation === "vertical" ? "flex-col gap-1.5" : "items-center justify-between gap-3",
        className,
      )}
      {...props}
    />
  );
}

/** Label and description beside a horizontal field's control. */
function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-content" className={cn("flex min-w-0 flex-1 flex-col gap-1", className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="field-label" className={cn("text-xs text-dim", className)} {...props} />;
}

/** A field's title when its control names itself, such as a switch or a segmented control. */
function FieldTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="field-title" className={cn("text-xs text-dim", className)} {...props} />;
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p data-slot="field-description" className={cn("m-0 text-xs leading-relaxed text-dim", className)} {...props} />
  );
}

function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p data-slot="field-error" role="alert" className={cn("m-0 text-xs text-destructive", className)} {...props} />
  );
}

export { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle };
