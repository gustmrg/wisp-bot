import { createContext, useContext } from "react";

import type { ConnectionsView } from "../../../shared/connections";

/** The connection the app is using, provided by `ConnectionGate`. */
export const ActiveConnectionContext = createContext<ConnectionsView | null>(null);

/**
 * Whether the backend can use this computer's screen: open its folders in the
 * file manager. Only true for Wisps on this computer in the desktop app; a
 * server elsewhere, or the browser app, cannot. Attaching files works
 * everywhere: other devices send the files to the server.
 */
export function useScreenActions(): boolean {
  const view = useContext(ActiveConnectionContext);
  // Without a gate (component tests), the desktop's local mode is assumed.
  return view === null || view.status.phase === "local";
}
