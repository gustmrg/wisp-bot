import { createContext, useContext, type ReactNode } from "react";
import type { BackendApi } from "../../../shared/backend-api";
import type { WispApi } from "../../../shared/contracts";
import type { DesktopApi } from "../../../shared/desktop-api";
import type { CurrentUser } from "../../../shared/current-user";

export interface BackendEnvironment {
  api: BackendApi;
  desktop?: DesktopApi;
  instanceId: string;
  remote: boolean;
  writable: boolean;
  owner?: CurrentUser;
  openAccount?: () => void;
}
const BackendContext = createContext<BackendEnvironment | null>(null);

export function BackendProvider({ value, children }: { value: BackendEnvironment; children: ReactNode }) {
  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}

/** The fallback keeps the local preload usable by isolated component consumers. */
export function useBackend(): BackendEnvironment {
  const environment = useContext(BackendContext);
  if (environment) return environment;
  const bridge = Reflect.get(window, "wisp") as WispApi | undefined;
  if (!bridge) throw new Error("A backend connection is required.");
  return { api: bridge, desktop: bridge, instanceId: "local", remote: false, writable: true };
}
export function useBackendApi(): BackendApi {
  return useBackend().api;
}

export function useBackendInstanceId(): string {
  return useContext(BackendContext)?.instanceId ?? "local";
}
