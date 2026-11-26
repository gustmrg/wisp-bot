import { useContext, useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LaptopIcon,
  LoaderCircleIcon,
  ServerIcon,
  Settings2,
  ShieldAlertIcon,
} from "lucide-react";

import { environmentPhase } from "@/components/settings/settings-environment-selector";
import { StatusDot } from "@/components/settings/settings-primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { LOCAL_CONNECTION_ID, type ConnectionProfileView, type ConnectionStatus } from "../../../shared/connections";
import { ActiveConnectionContext } from "./active-connection";
import { addressOf } from "./connection-screen";
import { phaseTone } from "./connections-panel";

function ProfileIcon({ profile, className }: { profile: ConnectionProfileView | undefined; className?: string }) {
  const Icon = profile?.kind === "local" ? LaptopIcon : ServerIcon;
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}

function statusLabel(phase: ConnectionStatus["phase"], name: string): string {
  if (phase === "local") return `Using ${name}`;
  if (phase === "reconnecting") return `Reconnecting to ${name}`;
  return `Connected to ${name}`;
}

function profileDetail(profile: ConnectionProfileView): string {
  const address = addressOf(profile);
  return profile.kind !== "local" && !profile.paired ? `${address} · Not paired yet` : address;
}

/**
 * Says which connection the app is using, and switches to another one, from
 * the desktop sidebar. Each connection is its own environment, with its own
 * Wisps and conversations, so it matters which one is open. With only one
 * there is nothing to tell apart, and the browser app has just its server.
 */
export function ConnectionSwitcher({ rail = false, onManage }: { rail?: boolean; onManage: () => void }) {
  const view = useContext(ActiveConnectionContext);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [localStops, setLocalStops] = useState(false);
  const leavingLocal = view?.activeId === LOCAL_CONNECTION_ID;
  const keepLocalRunning = view?.keepLocalRunning ?? true;

  // This computer's Wisps stop only when keepLocalRunning is explicitly off and remote access is disabled.
  useEffect(() => {
    if (!open || !leavingLocal || keepLocalRunning) {
      setLocalStops(false);
      return;
    }
    let current = true;
    void window.wisp
      .getRemoteAccess()
      .then((result) => {
        if (current) setLocalStops(!result.ok || !result.value.enabled);
      })
      .catch(() => {
        if (current) setLocalStops(true);
      });
    return () => {
      current = false;
    };
  }, [open, leavingLocal, keepLocalRunning]);

  if (!view || view.canManage === false || view.profiles.length < 2) return null;
  const active = view.profiles.find(({ id }) => id === view.activeId);
  const name = active?.name ?? "This computer";
  const label = statusLabel(view.status.phase, name);

  let otherApprovals = 0;
  let otherUnread = 0;
  for (const profile of view.profiles) {
    if (profile.id === view.activeId) continue;
    const summary = view.environments?.[profile.id];
    if (!summary) continue;
    otherApprovals += summary.pendingApprovals;
    otherUnread += summary.unreadConversations;
  }

  const activityNotes = [
    otherApprovals > 0
      ? `${otherApprovals} pending ${otherApprovals === 1 ? "approval" : "approvals"} in another environment`
      : null,
    otherUnread > 0 ? `${otherUnread} unread in another environment` : null,
  ].filter(Boolean);
  const triggerAriaLabel = activityNotes.length
    ? `${label}. ${activityNotes.join(", ")}. Switch connection`
    : `${label}. Switch connection`;

  async function switchTo(id: string): Promise<void> {
    setSwitching(id);
    setError("");
    try {
      // The connection screen takes over while it connects, and the main process pushes the new state.
      const result = await window.wisp.activateConnection({ id });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("The connection could not be changed.");
    } finally {
      setSwitching(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "relative flex min-w-0 flex-none items-center gap-[9px] rounded-[9px] border-0 bg-transparent p-1.5 text-left text-xs text-dim hover:bg-muted hover:text-foreground",
              "mt-[5px] mx-3",
              rail && "mx-auto",
            )}
            aria-label={triggerAriaLabel}
            title={activityNotes.length ? `${label} (${activityNotes.join(", ")})` : label}
          />
        }
      >
        <span className="relative flex size-[26px] flex-none items-center justify-center">
          <ProfileIcon profile={active} />
          <span className="absolute right-0.5 bottom-0.5 flex">
            <StatusDot tone={phaseTone(view.status.phase)} />
          </span>
          {rail && (otherApprovals > 0 || otherUnread > 0) ? (
            <span
              data-slot="other-env-indicator"
              aria-hidden="true"
              className={cn(
                "absolute top-0 right-0 size-2 rounded-full border border-sidebar",
                otherApprovals > 0 ? "bg-warning-solid" : "bg-[#ff3b30]",
              )}
            />
          ) : null}
        </span>
        {rail ? null : (
          <>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {otherApprovals > 0 ? (
              <span
                data-slot="other-env-indicator"
                aria-hidden="true"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning-solid/15 px-1.5 py-px text-2xs font-semibold text-warning tabular-nums"
              >
                <ShieldAlertIcon className="size-2.5" />
                {otherApprovals}
              </span>
            ) : otherUnread > 0 ? (
              <span
                data-slot="other-env-indicator"
                aria-hidden="true"
                className="inline-flex shrink-0 items-center rounded-full bg-[#ff3b30]/15 px-1.5 py-px text-2xs font-semibold text-[#ff3b30] tabular-nums"
              >
                {otherUnread}
              </span>
            ) : null}
            <ChevronsUpDownIcon aria-hidden="true" className="size-3 shrink-0" />
          </>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Connections">
          {view.profiles.map((profile) => {
            const isActive = profile.id === view.activeId;
            const envPhase = environmentPhase(view, profile.id);
            const summary = view.environments?.[profile.id];
            const badges = summary ? (
              <span className="mt-1 flex flex-wrap items-center gap-1">
                {summary.pendingApprovals > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-warning-solid/15 px-1.5 py-px text-2xs font-medium text-warning tabular-nums">
                    <ShieldAlertIcon aria-hidden="true" className="size-2.5" />
                    <span aria-hidden="true">{summary.pendingApprovals}</span>
                    <span className="sr-only">
                      {`${summary.pendingApprovals} pending ${summary.pendingApprovals === 1 ? "approval" : "approvals"}`}
                    </span>
                  </span>
                ) : null}
                {summary.workingWisps > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-px text-2xs font-medium text-emerald-600 dark:text-emerald-400 tabular-nums">
                    <LoaderCircleIcon aria-hidden="true" className="size-2.5 animate-spin" />
                    <span aria-hidden="true">{summary.workingWisps}</span>
                    <span className="sr-only">{`${summary.workingWisps} working`}</span>
                  </span>
                ) : null}
                {summary.unreadConversations > 0 ? (
                  <span className="inline-flex items-center rounded-full bg-[#ff3b30]/15 px-1.5 py-px text-2xs font-medium text-[#ff3b30] tabular-nums">
                    <span aria-hidden="true">{summary.unreadConversations}</span>
                    <span className="sr-only">{`${summary.unreadConversations} unread`}</span>
                  </span>
                ) : null}
              </span>
            ) : null;
            const hasBadges = Boolean(
              summary && (summary.pendingApprovals > 0 || summary.workingWisps > 0 || summary.unreadConversations > 0),
            );
            const copy = (
              <>
                <span className="relative flex size-7 flex-none items-center justify-center rounded-md bg-muted">
                  <ProfileIcon profile={profile} className="text-dim" />
                  <span className="absolute -right-0.5 -bottom-0.5 flex rounded-full bg-popover p-px">
                    <StatusDot tone={phaseTone(envPhase)} />
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{profile.name}</span>
                  <span className="block truncate text-xs text-dim">{profileDetail(profile)}</span>
                  {hasBadges ? badges : null}
                </span>
              </>
            );
            return (
              <li key={profile.id}>
                {isActive ? (
                  <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5" aria-current="true">
                    {copy}
                    <CheckIcon aria-label="In use" className="size-3.5 shrink-0 text-dim" />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    aria-label={`Switch to ${profile.name}`}
                    disabled={switching !== null}
                    onClick={() => void switchTo(profile.id)}
                  >
                    {copy}
                    {switching === profile.id ? (
                      <span role="status" className="shrink-0 text-xs text-dim">
                        Switching…
                      </span>
                    ) : null}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {leavingLocal && !keepLocalRunning && localStops ? (
          <p className="mx-2 mt-2 mb-1 text-xs leading-relaxed text-dim">
            Switching stops the Wisps on this computer once they finish what they are doing.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mx-2 mt-2 mb-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-xs text-dim outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Settings2 aria-hidden="true" className="size-3.5 shrink-0" />
            Manage connections
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
