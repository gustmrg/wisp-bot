import { useId } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

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
  return <div className={cn("flex min-h-[58px] items-center gap-3 px-3.5 py-[11px]", className)} {...props} />;
}

export function SettingsRowCopy({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("flex min-w-0 flex-1 flex-col gap-[3px]", className)} {...props} />;
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
