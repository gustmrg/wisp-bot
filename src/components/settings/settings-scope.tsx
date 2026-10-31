import { useContext } from "react";
import type { ReactNode } from "react";
import { MonitorSmartphoneIcon, ServerIcon } from "lucide-react";

import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { cn } from "@/lib/utils";

/**
 * Where a setting is saved: on this `device` only, or in the `environment` the
 * app is connected to, which every device connected to it shares.
 */
export type SettingsScope = "device" | "environment";

/**
 * Says where settings are saved once that makes a difference: on a server,
 * changing one changes it for every device. With the desktop's own Wisps the
 * device and the environment are the same computer, so it says nothing.
 */
export function SettingsScopeNote({ scope }: { scope: SettingsScope }) {
  const view = useContext(ActiveConnectionContext);
  // Without a gate (component tests), the desktop's local mode is assumed.
  if (!view || view.status.phase === "local") return null;
  const name = view.profiles.find(({ id }) => id === view.activeId)?.name ?? "This server";
  const Icon = scope === "device" ? MonitorSmartphoneIcon : ServerIcon;
  const detail = scope === "device" ? "Saved on this device." : `Saved on ${name}, for every device connected to it.`;
  return (
    <span title={detail} className="inline-flex items-center gap-1 text-2xs text-faint [&_svg]:size-3">
      <Icon aria-hidden="true" />
      <span aria-hidden="true">{scope === "device" ? "This device" : name}</span>
      <span className="sr-only">{detail}</span>
    </span>
  );
}

/** A settings panel's title, with where its settings are saved beside it. */
export function SettingsPanelTitle({
  id,
  scope,
  className,
  children,
}: {
  id: string;
  scope: SettingsScope;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-1 flex flex-wrap items-center justify-between gap-x-3", className)}>
      <h2 id={id} className="m-0 text-lg font-semibold">
        {children}
      </h2>
      <SettingsScopeNote scope={scope} />
    </div>
  );
}
