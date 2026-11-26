import type { ReactNode } from "react";

import { SettingsEnvironmentSelector } from "@/components/settings/settings-environment-selector";
import { cn } from "@/lib/utils";

/**
 * Where a setting is saved: on this `device` only, or in the `environment` the
 * Settings dialog is inspecting.
 */
export type SettingsScope = "device" | "environment";

/**
 * A settings panel's heading. Environment-scoped panels render the actionable
 * environment selector on the right when two or more environments exist.
 */
export function SettingsPanelTitle({
  id,
  scope,
  className,
  children,
}: {
  id: string;
  scope?: SettingsScope;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pr-9", className)}>
      <h2 id={id} className="m-0 text-lg font-semibold">
        {children}
      </h2>
      {scope === "environment" ? <SettingsEnvironmentSelector /> : null}
    </div>
  );
}
