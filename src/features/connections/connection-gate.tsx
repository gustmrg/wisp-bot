import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleCheckIcon,
  CircleXIcon,
  LaptopIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ServerIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";

import { ToastFrame } from "@/components/update-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { APP_METADATA } from "@/config/app-metadata";
import { useMobileLayout } from "@/hooks/use-mobile-layout";
import { cn } from "@/lib/utils";
import { LOCAL_CONNECTION_ID, type ConnectionsView } from "../../../shared/connections";
import { ActiveConnectionContext } from "./active-connection";
import {
  activeName,
  activeProfile,
  addressOf,
  canUseThisComputer,
  ConnectionScreen,
  ServerChip,
} from "./connection-screen";
import { CONNECTION_BACKDROP, formatDuration, useNow } from "./connection-steps";
import { ConnectionsPanel } from "./connections-panel";
import { SshPromptDialog } from "./ssh-prompt-dialog";
import { compareVersions, UpdateServerDialog } from "./update-server-dialog";

/** The active connection, kept current from the main process. */
export function useConnections(): [ConnectionsView | null, string] {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const unsubscribe = window.wisp.subscribeToConnections((next) => {
      if (current) setView(next);
    });
    void window.wisp
      .getConnections()
      .then((result) => {
        if (!current) return;
        // A pushed view may already be newer than this answer.
        if (result.ok) setView((existing) => existing ?? result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (current) setError("Wisp could not read its connections.");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return [view, error];
}

/**
 * Shows the app only while its backend can answer: on this computer, or on a
 * connected server. The app remounts when the backend changes or a reconnect
 * missed events, so it reloads everything from the new source.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const [view, error] = useConnections();
  const [toast, setToast] = useState<ToastContent>();
  const previous = useRef<ConnectionsView | null>(null);
  useEffect(() => {
    const next = view ? toastFor(previous.current, view) : undefined;
    if (next) setToast(next);
    previous.current = view;
  }, [view]);
  const dismissToast = useCallback(() => setToast(undefined), []);
  // OpenSSH can ask while connecting, reconnecting, or setting a server up.
  return (
    <>
      <GateContent view={view} error={error}>
        {children}
      </GateContent>
      {view?.sshPrompt ? <SshPromptDialog prompt={view.sshPrompt} /> : null}
      {toast ? <ConnectionToast key={toast.key} toast={toast} onDismiss={dismissToast} /> : null}
    </>
  );
}

function GateContent({ view, error, children }: { view: ConnectionsView | null; error: string; children: ReactNode }) {
  const [dismissedVersion, setDismissedVersion] = useState("");
  const now = useNow(view?.status.phase === "reconnecting");
  if (!view) {
    return error ? <ConnectionMessage title="Wisp could not start" message={error} /> : <Opening />;
  }
  const { status } = view;
  if (status.phase === "local" || status.phase === "connected" || status.phase === "reconnecting") {
    // The banner takes its own row so it never covers the app; the app keeps
    // its place in the tree, so showing the banner does not remount it.
    return (
      <div className="flex h-full min-h-0 flex-col">
        {status.phase === "reconnecting" ? <ReconnectingBanner view={view} now={now} /> : null}
        {status.phase === "connected" &&
        status.serverVersion &&
        status.serverVersion !== APP_METADATA.version &&
        dismissedVersion !== `${view.activeId}:${status.serverVersion}` ? (
          <VersionMismatchBanner
            view={view}
            serverVersion={status.serverVersion}
            onDismiss={() => setDismissedVersion(`${view.activeId}:${status.serverVersion}`)}
          />
        ) : null}
        <div
          className={cn(
            "min-h-0 flex-1 transition-opacity",
            // Away for long, what the app shows may be out of date.
            status.phase === "reconnecting" &&
              status.retry &&
              now - status.retry.since >= LONG_OUTAGE_MS &&
              "opacity-60",
          )}
        >
          <ActiveConnectionContext.Provider value={view}>
            <Fragment key={`${view.activeId}:${status.epoch}`}>{children}</Fragment>
          </ActiveConnectionContext.Provider>
        </div>
      </div>
    );
  }
  if (status.phase === "choosing") return <FirstRunChoice view={view} />;
  return <ConnectionScreen view={view} />;
}

/**
 * The first screen of a new installation: where Wisps run. Nothing runs until
 * the person chooses, and each place keeps its own Wisps and settings.
 */
function FirstRunChoice({ view }: { view: ConnectionsView }) {
  const [serverOpen, setServerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function chooseThisComputer() {
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.activateConnection({ id: LOCAL_CONNECTION_ID });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Wisp could not start on this computer.");
    } finally {
      setBusy(false);
    }
  }

  const option =
    "flex w-full items-start gap-3 rounded-xl border border-border p-4 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <main className="flex h-full min-h-0 items-start justify-center overflow-y-auto bg-background p-6 text-foreground max-[620px]:p-3">
      <section
        className="my-auto w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm"
        aria-labelledby="first-run-title"
      >
        <h1 id="first-run-title" className="m-0 text-lg font-semibold">
          Where should your Wisps run?
        </h1>
        <p className="mb-4 mt-1 text-base leading-relaxed text-dim">
          Each place keeps its own Wisps, conversations, and settings. You can add the other one later in Settings.
        </p>
        <div className="flex flex-col gap-2">
          <button type="button" className={option} disabled={busy} onClick={() => void chooseThisComputer()}>
            <LaptopIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-dim" />
            <span>
              <span className="flex items-center gap-2 text-base font-medium">
                On this computer
                <span className="rounded-full bg-muted px-1.5 py-px text-2xs font-medium text-dim">Recommended</span>
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-dim">
                Wisps work while this app is open, and everything stays on this computer.
              </span>
            </span>
          </button>
          <button
            type="button"
            className={option}
            aria-expanded={serverOpen}
            disabled={busy}
            onClick={() => setServerOpen(true)}
          >
            <ServerIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-dim" />
            <span>
              <span className="block text-base font-medium">On a Wisp server</span>
              <span className="mt-1 block text-sm leading-relaxed text-dim">
                Wisps keep working with this app closed. Connect to a server you run, over SSH or a private HTTPS
                address.
              </span>
            </span>
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {serverOpen ? (
          <div className="mt-4 border-t border-border pt-4">
            <ConnectionsPanel view={view} serversOnly />
          </div>
        ) : null}
      </section>
    </main>
  );
}

const LONG_OUTAGE_MS = 2 * 60_000;

/**
 * Shown above the app while the server is away. The app keeps its place, and
 * Wisps on the server keep working. After a while away it turns red and the
 * app dims, since what it shows may be out of date.
 */
function ReconnectingBanner({ view, now }: { view: ConnectionsView; now: number }) {
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const mobile = useMobileLayout();
  const { retry } = view.status;
  const name = activeName(view);
  const away = retry ? now - retry.since : 0;
  const long = away >= LONG_OUTAGE_MS;
  const next = retry?.nextAttemptAt ? Math.max(0, Math.ceil((retry.nextAttemptAt - now) / 1000)) : undefined;
  const meta = long
    ? `${name} · still retrying`
    : [
        retry ? `Attempt ${retry.attempt + 1}` : undefined,
        next === undefined ? undefined : `next in ${next}s`,
        "Wisps on it keep working",
      ]
        .filter(Boolean)
        .join(" · ");
  const canManage = view.canManage !== false;
  const detailsContent = <ReconnectDetails view={view} now={now} />;
  return (
    <div
      role={long ? "alert" : "status"}
      className={cn(
        "flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3.5 py-1.5 text-sm text-foreground",
        "max-[760px]:grid max-[760px]:grid-cols-[16px_minmax(0,1fr)] max-[760px]:gap-x-2 max-[760px]:gap-y-0.5 max-[760px]:px-3 max-[760px]:py-2",
        long
          ? "[--tone:var(--destructive)] border-destructive/25 bg-[color-mix(in_srgb,var(--destructive)_13%,var(--background))]"
          : "[--tone:var(--warning-solid)] border-warning-solid/25 bg-[color-mix(in_srgb,var(--warning-solid)_13%,var(--background))]",
      )}
    >
      <span className="flex text-[var(--tone)] max-[760px]:row-span-2 max-[760px]:self-center">
        {long ? (
          <WifiOffIcon aria-hidden="true" className="size-4" />
        ) : (
          <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
        )}
      </span>
      <span className="font-medium max-[760px]:col-start-2">
        {long ? `Unreachable for ${Math.floor(away / 60_000)} min` : `Reconnecting to ${name}`}
      </span>
      <span className="text-dim before:content-['·_'] max-[760px]:col-start-2 max-[760px]:text-xs max-[760px]:before:content-none">
        {meta}
      </span>
      <div className="ml-auto flex flex-wrap gap-1.5 max-[760px]:col-start-2 max-[760px]:mt-1 max-[760px]:ml-0">
        <Button type="button" size="xs" variant="outline" onClick={() => void window.wisp.retryConnection()}>
          Retry now
        </Button>
        {long && canManage ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(true)}>
            Edit connection
          </Button>
        ) : null}
        {mobile ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => setDetails(true)}>
            Details
          </Button>
        ) : (
          <Popover open={details} onOpenChange={setDetails}>
            <PopoverTrigger render={<Button type="button" size="xs" variant="ghost" />}>Details</PopoverTrigger>
            <PopoverContent side="bottom" className="w-80 p-4">
              {detailsContent}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {mobile && details ? (
        <Dialog open onOpenChange={setDetails}>
          <DialogContent backdropClassName={CONNECTION_BACKDROP} className="self-end pt-11">
            <DialogTitle className="sr-only">Connection details</DialogTitle>
            {detailsContent}
          </DialogContent>
        </Dialog>
      ) : null}
      {editing ? (
        <Dialog open onOpenChange={setEditing}>
          <DialogContent backdropClassName={CONNECTION_BACKDROP}>
            <DialogTitle className="sr-only">Edit connection</DialogTitle>
            <ConnectionsPanel view={view} initialEditing={view.activeId} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The gist of a failure for the list of attempts: its first sentence, without the code marks. */
function firstSentence(message: string): string {
  const plain = message.replaceAll("`", "");
  const end = plain.search(/\.\s/);
  return end < 0 ? plain : plain.slice(0, end + 1);
}

/** How long the server has been away, why each attempt failed, and when the next one starts. */
function ReconnectDetails({ view, now }: { view: ConnectionsView; now: number }) {
  const { retry } = view.status;
  const profile = activeProfile(view);
  const name = activeName(view);
  const failures = retry?.failures ?? [];
  const next = retry?.nextAttemptAt ? Math.max(0, Math.ceil((retry.nextAttemptAt - now) / 1000)) : undefined;
  const firstAttempt = (retry?.attempt ?? 0) - failures.length + 1;
  return (
    <div className="[--tone:var(--warning-solid)] text-sm">
      {profile ? <ServerChip profile={profile} serverVersion={view.status.serverVersion} /> : null}
      <h3 className="mt-3 mb-0 text-base font-semibold">
        {retry ? `Lost the connection ${formatDuration(now - retry.since)} ago` : "Lost the connection"}
      </h3>
      <p className="mt-1 mb-0 leading-relaxed text-dim">
        Wisps on {name} keep running; you will see what they did when the app reconnects.
      </p>
      <ol className="mt-3 mb-0 flex list-none flex-col gap-2 p-0" aria-label="Attempts">
        {failures.map((failure, index) => (
          <li key={failure.at} className="grid grid-cols-[16px_1fr_auto] gap-2">
            <CircleXIcon aria-hidden="true" className="mt-0.5 size-4 text-destructive" />
            <span>
              Attempt {Math.max(1, firstAttempt + index)}
              <span className="block text-xs break-words text-destructive">{firstSentence(failure.message)}</span>
            </span>
            <span className="text-xs text-faint tabular-nums">
              {retry ? formatDuration(failure.at - retry.since) : ""}
            </span>
          </li>
        ))}
        <li className="grid grid-cols-[16px_1fr_auto] gap-2">
          <LoaderCircleIcon aria-hidden="true" className="mt-0.5 size-4 animate-spin text-[var(--tone)]" />
          <span>
            Attempt {(retry?.attempt ?? 0) + 1}
            <span className="block text-xs text-dim">
              {next === undefined ? "Trying now…" : `Next try in ${next}s`}
            </span>
          </span>
        </li>
      </ol>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => void window.wisp.retryConnection()}>
          <RefreshCwIcon aria-hidden="true" />
          Retry now
        </Button>
        {canUseThisComputer(view) ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void window.wisp.activateConnection({ id: LOCAL_CONNECTION_ID }).catch(() => undefined)}
          >
            <LaptopIcon aria-hidden="true" />
            Use this computer instead
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The server speaks this app's protocol, but some features may differ until both run the same version. */
function VersionMismatchBanner({
  view,
  serverVersion,
  onDismiss,
}: {
  view: ConnectionsView;
  serverVersion: string;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const appVersion = APP_METADATA.version;
  const serverIsOlder = compareVersions(serverVersion, appVersion) < 0;
  const profile = activeProfile(view);
  // An SSH server can be updated right here, after the person confirms.
  const canUpdate = serverIsOlder && profile?.kind === "ssh" && view.canManage !== false;
  const advice = !serverIsOlder
    ? "Update this app so every feature works."
    : canUpdate
      ? "Update it so every feature works."
      : "Update the server so every feature works.";
  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center justify-center gap-x-3 gap-y-2 bg-warning-solid/15 px-4 py-1.5 text-sm text-foreground"
    >
      <span>
        {activeName(view)} runs Wisp server {serverVersion}, {serverIsOlder ? "older" : "newer"} than this app (
        {appVersion}). {advice}
      </span>
      {canUpdate ? (
        <Button type="button" size="xs" variant="outline" onClick={() => setConfirming(true)}>
          Update server
        </Button>
      ) : null}
      <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon aria-hidden="true" />
      </Button>
      {confirming && profile?.kind === "ssh" ? (
        <UpdateServerDialog
          name={activeName(view)}
          host={profile.host}
          serverVersion={serverVersion}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void window.wisp.installServer({ id: profile.id }).catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}

const CONNECTED_TOAST_MS = 4_000;
const UPDATED_TOAST_MS = 12_000;

type ToastContent = { key: string; title: string; detail: string; durationMs: number };

/**
 * What the last change of connection deserves a toast for: a server just
 * connected, or set up or updated. Reconnecting quietly needs none.
 */
function toastFor(previous: ConnectionsView | null, view: ConnectionsView): ToastContent | undefined {
  if (!previous || view.status.phase !== "connected" || previous.status.phase === "connected") return undefined;
  if (previous.status.phase === "reconnecting") return undefined;
  const profile = activeProfile(view);
  if (!profile) return undefined;
  const version = view.status.serverVersion;
  const setup = previous.activeId === view.activeId ? previous.status.progress : undefined;
  if (setup && setup.kind !== "connect") {
    return {
      key: `${view.activeId}:${view.status.epoch}:setup`,
      title:
        setup.kind === "update"
          ? `${profile.name} updated to ${version ?? APP_METADATA.version}`
          : `Wisp is set up on ${profile.name}`,
      detail: setup.fromVersion ? `Previously ${setup.fromVersion}.` : `${addressOf(profile)}`,
      durationMs: UPDATED_TOAST_MS,
    };
  }
  return {
    key: `${view.activeId}:${view.status.epoch}:connected`,
    title: `Connected to ${profile.name}`,
    detail: `${addressOf(profile)}${version ? ` · server ${version}` : ""}`,
    durationMs: CONNECTED_TOAST_MS,
  };
}

function ConnectionToast({ toast, onDismiss }: { toast: ToastContent; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);
  return (
    <ToastFrame>
      <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-green" />
      <div className="grid min-w-0 gap-0.5">
        <strong className="text-sm">{toast.title}</strong>
        <span className="truncate text-xs text-dim">{toast.detail}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Dismiss"
        className="-mt-1 -mr-1 ml-auto"
        onClick={onDismiss}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </ToastFrame>
  );
}

/** Shown for the moment before the app knows its connection, so the window is never blank. */
function Opening() {
  return (
    <main className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-background p-6 text-dim">
      <LoaderCircleIcon aria-hidden="true" className="size-5 animate-spin" />
      <p className="m-0 text-base">Opening Wisp…</p>
    </main>
  );
}

function ConnectionMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm" role="alert">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-base leading-relaxed text-dim">{message}</p>
      </section>
    </main>
  );
}
