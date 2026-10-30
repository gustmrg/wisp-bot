import { useContext } from "react";

import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { LOCAL_CONNECTION_ID } from "../../../shared/connections";

/**
 * Where a setting is saved: on this `device` only, or in the `environment` the
 * app is connected to, which every device connected to it shares.
 */
export type SettingsScope = "device" | "environment";

/** Says where settings are saved, naming the server, since changing one there changes it for every device. */
export function SettingsScopeNote({ scope }: { scope: SettingsScope }) {
  const view = useContext(ActiveConnectionContext);
  if (scope === "device") return <>Saved on this device.</>;
  // Without a gate (component tests), the desktop's local mode is assumed.
  if (!view || view.activeId === LOCAL_CONNECTION_ID) return <>Saved for the Wisps on this computer.</>;
  const name = view.profiles.find(({ id }) => id === view.activeId)?.name ?? "this server";
  return <>Saved on {name}, for every device connected to it.</>;
}
