import { useContext } from "react";
import { ChevronRightIcon, TriangleAlertIcon, UserIcon } from "lucide-react";

import type { CurrentUser } from "@/config/app-metadata";
import { StatusDot } from "@/components/settings/settings-primitives";
import { ActiveConnectionContext } from "@/features/connections/active-connection";
import { profileAvatar } from "@/lib/ui-classes";
import type { ConnectionPhase } from "../../shared/connections";

/** Phases the overview can show; the connection gate covers the app in the others. */
const PHASE_LABELS: Partial<Record<ConnectionPhase, string>> = {
  local: "Running here",
  connected: "Connected",
  reconnecting: "Reconnecting…",
};

interface MobileSettingsProfileProps {
  currentUser: CurrentUser;
  appVersion: string;
  onOpenProfile: () => void;
  onOpenConnection: () => void;
}

/** Who and where, at the top of the mobile Settings overview (ADR 014). */
export function MobileSettingsProfile({
  currentUser,
  appVersion,
  onOpenProfile,
  onOpenConnection,
}: MobileSettingsProfileProps) {
  const view = useContext(ActiveConnectionContext);
  // Without a gate (component tests), the desktop's local mode is assumed.
  const phase = view?.status.phase ?? "local";
  const connectionName = view?.profiles.find(({ id }) => id === view.activeId)?.name ?? "This computer";
  const serverVersion = view?.status.serverVersion;
  const versionDiffers = Boolean(serverVersion && serverVersion !== appVersion);
  const status = [PHASE_LABELS[phase] ?? "Not connected", view?.deviceName].filter(Boolean).join(" · ");
  return (
    <div className="mobile-settings-profile">
      <button type="button" onClick={onOpenProfile}>
        <span className={profileAvatar} aria-hidden="true">
          {currentUser.initials || <UserIcon className="size-3.5" />}
        </span>
        <span className="mobile-settings-copy">
          <strong>{currentUser.displayName}</strong>
        </span>
        <ChevronRightIcon aria-hidden="true" className="mobile-settings-chevron" />
      </button>
      <button
        type="button"
        aria-label={[connectionName, status, versionDiffers ? "server version differs from this app" : ""]
          .filter(Boolean)
          .join(", ")}
        onClick={onOpenConnection}
      >
        <span className="mobile-connection-dot" aria-hidden="true">
          <StatusDot tone={phase === "local" || phase === "connected" ? "success" : "warning"} />
        </span>
        <span className="mobile-settings-copy">
          <strong>{connectionName}</strong>
          <small>{status}</small>
        </span>
        {versionDiffers ? (
          <span className="mobile-settings-badge">
            <TriangleAlertIcon aria-hidden="true" />
            Version differs
          </span>
        ) : null}
        <ChevronRightIcon aria-hidden="true" className="mobile-settings-chevron" />
      </button>
    </div>
  );
}
