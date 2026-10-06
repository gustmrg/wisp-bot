import type { ReactNode } from "react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface AccessOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * One service in a Wisp's Access tab. Plugins, web capabilities and MCP servers
 * share this row so every connection reads the same way.
 */
export function AccessRow({
  id,
  icon,
  label,
  value,
  options,
  disabled = false,
  onChange,
  notice,
}: {
  id: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ReadonlyArray<AccessOption>;
  disabled?: boolean;
  onChange: (value: string) => void;
  notice?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center gap-2.5">
        {icon}
        <label htmlFor={id} className="min-w-0 flex-1 leading-snug font-medium break-words">
          {label}
        </label>
        <Select
          value={value}
          items={options}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string" && !options.find((option) => option.value === next)?.disabled) onChange(next);
          }}
        >
          <SelectTrigger id={id} aria-label={`${label} access`} className="w-[136px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false}>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {notice ? <div className="leading-relaxed text-dim">{notice}</div> : null}
    </div>
  );
}

/** Initials badge for connections without a bundled logo, sized like a small plugin logo. */
export function InitialsBadge({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 flex-none items-center justify-center rounded-lg bg-muted text-2xs font-medium"
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
