import { createContext, useContext, useState } from "react";
import { LaptopIcon, LoaderCircleIcon, ServerIcon, WifiOffIcon } from "lucide-react";

import { SettingsCard, StatusDot } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "@/components/ui/select";
import { phaseTone } from "@/features/connections/connections-panel";
import type { ConnectionPhase, ConnectionProfileView, ConnectionsView } from "../../../shared/connections";

export interface SettingsEnvironmentContextValue {
  connectionsView: ConnectionsView;
  selectedEnvironmentId: string;
  activeEnvironmentId: string;
  selectedProfile: ConnectionProfileView | undefined;
  selectedPhase: ConnectionPhase;
  isSelectedConnected: boolean;
  isActiveEnvironment: boolean;
  onSelectEnvironment: (environmentId: string) => void;
  onOpenConnections: () => void;
}

export const SettingsEnvironmentContext = createContext<SettingsEnvironmentContextValue | null>(null);

export function useSettingsEnvironment(): SettingsEnvironmentContextValue | null {
  return useContext(SettingsEnvironmentContext);
}

/** Live connection phase of one profile in `view`, falling back to active status or pairing state. */
export function environmentPhase(view: ConnectionsView, profileId: string): ConnectionPhase {
  const summary = view.environments?.[profileId];
  if (summary) return summary.phase;
  if (profileId === view.activeId) return view.status.phase;
  const profile = view.profiles.find(({ id }) => id === profileId);
  if (profile && profile.kind !== "local" && !profile.paired) return "pairing_required";
  return "choosing";
}

export function isEnvironmentConnected(phase: ConnectionPhase): boolean {
  return phase === "local" || phase === "connected";
}

function offlinePhaseLabel(phase: ConnectionPhase, profile: ConnectionProfileView | undefined): string {
  if (phase === "pairing_required" || (profile && profile.kind !== "local" && !profile.paired)) {
    return "Not paired yet";
  }
  if (phase === "connecting") return "Connecting…";
  if (phase === "reconnecting") return "Reconnecting…";
  if (phase === "error") return "Cannot connect";
  return "Not connected";
}

function ProfileIcon({ profile, className }: { profile: ConnectionProfileView | undefined; className?: string }) {
  const Icon = profile?.kind === "local" ? LaptopIcon : ServerIcon;
  return <Icon aria-hidden="true" className={className} />;
}

/**
 * Actionable environment selector shown on the right of Environment Settings panel headings
 * when two or more environments exist in the desktop app. Changing it only switches which
 * environment Settings inspects and never calls `activateConnection`.
 */
export function SettingsEnvironmentSelector() {
  const ctx = useSettingsEnvironment();
  if (!ctx) return null;
  const { connectionsView, selectedEnvironmentId, selectedProfile, selectedPhase, onSelectEnvironment } = ctx;
  if (connectionsView.canManage === false || connectionsView.profiles.length < 2) return null;

  const items = connectionsView.profiles.map((profile) => ({ value: profile.id, label: profile.name }));
  const triggerLabel = selectedProfile?.name ?? "Select environment";

  return (
    <Select
      items={items}
      value={selectedEnvironmentId}
      onValueChange={(next) => {
        if (next !== null && next !== selectedEnvironmentId) onSelectEnvironment(next);
      }}
    >
      <SelectTrigger size="sm" aria-label="Environment" className="max-w-[240px] gap-1.5 text-xs font-normal">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <ProfileIcon profile={selectedProfile} className="size-3.5 shrink-0 text-dim" />
          <StatusDot tone={phaseTone(selectedPhase)} />
          <span className="truncate">{triggerLabel}</span>
        </span>
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className="min-w-[220px]">
        <SelectGroup>
          {connectionsView.profiles.map((profile) => {
            const phase = environmentPhase(connectionsView, profile.id);
            const connected = isEnvironmentConnected(phase);
            return (
              <SelectItem key={profile.id} value={profile.id} className="text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <ProfileIcon profile={profile} className="size-3.5 shrink-0 text-dim" />
                  <StatusDot tone={phaseTone(phase)} />
                  <span className="truncate">{profile.name}</span>
                  {connected ? null : (
                    <span className="shrink-0 text-2xs text-dim">{offlinePhaseLabel(phase, profile)}</span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * Shown inside an Environment Settings panel when the selected environment is not currently
 * connected, offering Connect (for paired or local profiles) and Open Connections.
 */
export function OfflineEnvironmentPanel({
  panelId,
  titleId,
  title,
  sectionClassName,
  titleClassName,
}: {
  panelId: string;
  titleId: string;
  title: string;
  sectionClassName?: string;
  titleClassName?: string;
}) {
  const ctx = useSettingsEnvironment();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  if (!ctx) return null;
  const { connectionsView, selectedEnvironmentId, selectedProfile, selectedPhase, onOpenConnections } = ctx;
  const name = selectedProfile?.name ?? "This environment";
  const unpaired =
    selectedPhase === "pairing_required" || (selectedProfile?.kind !== "local" && !selectedProfile?.paired);
  const inProgress = selectedPhase === "connecting" || selectedPhase === "reconnecting" || connecting;
  const summaryMessage = connectionsView.environments?.[selectedEnvironmentId]?.message;
  const statusLabel = offlinePhaseLabel(selectedPhase, selectedProfile);

  async function handleConnect() {
    if (!selectedProfile || unpaired || inProgress) return;
    setConnecting(true);
    setError("");
    try {
      const result = await window.wisp.connectEnvironment({ id: selectedProfile.id });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError(`Could not connect to ${name}.`);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section
      id={panelId}
      aria-labelledby={titleId}
      className={
        sectionClassName ?? "overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      }
    >
      <div className={titleClassName ?? "mb-[22px] flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pr-9"}>
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          {title}
        </h2>
        <SettingsEnvironmentSelector />
      </div>
      <div className="animate-panel-in">
        <SettingsCard className="flex flex-col gap-3 p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 flex-none items-center justify-center rounded-lg bg-muted text-dim">
              {inProgress ? (
                <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <WifiOffIcon aria-hidden="true" className="size-4" />
              )}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="m-0 flex items-center gap-2 text-sm font-semibold">
                <span className="truncate">{name}</span>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs font-normal text-dim">
                  <StatusDot tone={phaseTone(selectedPhase)} />
                  {statusLabel}
                </span>
              </p>
              <p className="m-0 text-xs leading-relaxed text-dim">
                {unpaired
                  ? `Pair ${name} in Connections before viewing or changing its settings.`
                  : inProgress
                    ? `Waiting for ${name} to connect. Settings will appear here once it is ready.`
                    : summaryMessage
                      ? summaryMessage
                      : `Connect to ${name} to view and change its settings.`}
              </p>
            </div>
          </div>
          {error ? (
            <p role="alert" className="m-0 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {unpaired ? null : (
              <Button type="button" size="sm" disabled={inProgress} onClick={() => void handleConnect()}>
                {inProgress ? "Connecting…" : "Connect"}
              </Button>
            )}
            <Button type="button" size="sm" variant={unpaired ? "default" : "outline"} onClick={onOpenConnections}>
              Open Connections
            </Button>
          </div>
        </SettingsCard>
      </div>
    </section>
  );
}
