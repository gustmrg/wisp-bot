import { Fragment, useEffect, useState, type ReactNode } from "react";
import { LaptopIcon, LoaderCircleIcon, ServerIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_METADATA } from "@/config/app-metadata";
import { LOCAL_CONNECTION_ID, type ConnectionsView } from "../../../shared/connections";
import { ActiveConnectionContext } from "./active-connection";
import { ConnectionsPanel } from "./connections-panel";
import { InstallServerAction } from "./install-server-action";
import { SshPromptDialog } from "./ssh-prompt-dialog";

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
  // OpenSSH can ask while connecting, reconnecting, or setting a server up.
  return (
    <>
      <GateContent view={view} error={error}>
        {children}
      </GateContent>
      {view?.sshPrompt ? <SshPromptDialog prompt={view.sshPrompt} /> : null}
    </>
  );
}

function GateContent({ view, error, children }: { view: ConnectionsView | null; error: string; children: ReactNode }) {
  const [dismissedVersion, setDismissedVersion] = useState("");
  if (!view) {
    return error ? <ConnectionMessage title="Wisp could not start" message={error} /> : null;
  }
  const { status } = view;
  if (status.phase === "local" || status.phase === "connected" || status.phase === "reconnecting") {
    // The banner takes its own row so it never covers the app; the app keeps
    // its place in the tree, so showing the banner does not remount it.
    return (
      <div className="flex h-full min-h-0 flex-col">
        {status.phase === "reconnecting" ? <ReconnectingBanner view={view} /> : null}
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
        <div className="min-h-0 flex-1">
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

function activeName(view: ConnectionsView): string {
  return view.profiles.find((profile) => profile.id === view.activeId)?.name ?? "the server";
}

/** Whether this client can leave the active server for the Wisps on this computer. */
function canUseThisComputer(view: ConnectionsView): boolean {
  return (
    view.canManage !== false &&
    view.activeId !== LOCAL_CONNECTION_ID &&
    view.profiles.some(({ kind }) => kind === "local")
  );
}

function ReconnectingBanner({ view }: { view: ConnectionsView }) {
  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center justify-center gap-3 bg-warning-solid/15 px-4 py-1.5 text-sm text-foreground"
    >
      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Reconnecting to {activeName(view)}. Wisps on it keep working.</span>
      <Button type="button" size="xs" variant="outline" onClick={() => void window.wisp.retryConnection()}>
        Retry now
      </Button>
      {canUseThisComputer(view) ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => void window.wisp.activateConnection({ id: LOCAL_CONNECTION_ID }).catch(() => undefined)}
        >
          Use this computer instead
        </Button>
      ) : null}
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
  const appVersion = APP_METADATA.version;
  const serverIsOlder = compareVersions(serverVersion, appVersion) < 0;
  const profile = view.profiles.find(({ id }) => id === view.activeId);
  const advice = !serverIsOlder
    ? "Update this app so every feature works."
    : profile?.kind === "ssh"
      ? "Update it in Settings → Connections so every feature works."
      : "Update the server so every feature works.";
  return (
    <div
      role="status"
      className="flex flex-none items-center justify-center gap-3 bg-warning-solid/15 px-4 py-1.5 text-sm text-foreground"
    >
      <span>
        {activeName(view)} runs Wisp server {serverVersion}, {serverIsOlder ? "older" : "newer"} than this app (
        {appVersion}). {advice}
      </span>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Compares dotted version numbers; anything after a `-` is ignored. */
function compareVersions(left: string, right: string): number {
  const parts = (version: string) => (version.split("-")[0] ?? "").split(".").map((part) => Number(part) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
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

/** Shown while the chosen server is connecting, needs pairing, or cannot be reached. */
function ConnectionScreen({ view }: { view: ConnectionsView }) {
  const { status } = view;
  const profile = view.profiles.find((candidate) => candidate.id === view.activeId);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  async function act(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) {
    setBusy(true);
    setActionError("");
    try {
      const result = await action();
      if (!result.ok) setActionError(result.error.message);
    } catch {
      setActionError("Wisp could not change the connection.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    status.phase === "connecting"
      ? `Connecting to ${activeName(view)}`
      : status.phase === "pairing_required"
        ? `Pair with ${activeName(view)}`
        : `Cannot use ${activeName(view)}`;

  return (
    <main className="flex h-full min-h-0 items-start justify-center overflow-y-auto bg-background p-6 text-foreground">
      <div className="my-auto w-full max-w-lg">
        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm" aria-labelledby="connection-title">
          <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-muted">
            {status.phase === "connecting" ? (
              <LoaderCircleIcon aria-hidden="true" className="size-5 animate-spin" />
            ) : (
              <ServerIcon aria-hidden="true" className="size-5" />
            )}
          </div>
          <h1 id="connection-title" className="text-lg font-semibold">
            {title}
          </h1>
          {status.message ? (
            <p role={status.phase === "error" ? "alert" : "status"} className="mt-2 text-base leading-relaxed text-dim">
              {status.message}
            </p>
          ) : null}
          {status.phase === "pairing_required" ? (
            <form
              className="mt-4 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() => window.wisp.activateConnection({ id: view.activeId, pairingCode: code }));
              }}
            >
              <Input
                aria-label="Pairing code"
                className="w-44 font-mono uppercase"
                placeholder="ABCDE-FGHJK"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" disabled={busy || code.trim().length === 0}>
                Pair
              </Button>
              {profile?.kind === "ssh" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void act(() => window.wisp.retryConnection())}
                >
                  Pair over SSH
                </Button>
              ) : null}
            </form>
          ) : null}
          {status.phase === "error" && profile?.kind === "ssh" ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-2 mt-0 text-sm leading-relaxed text-dim">
                If Wisp is not installed on {profile.host} yet, or is out of date, Wisp can set it up for you.
              </p>
              <InstallServerAction profileId={profile.id} host={profile.host} disabled={busy} />
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {status.installing ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => window.wisp.cancelServerInstall())}
              >
                Cancel setup
              </Button>
            ) : null}
            {status.phase === "error" ? (
              <Button type="button" disabled={busy} onClick={() => void act(() => window.wisp.retryConnection())}>
                Retry
              </Button>
            ) : null}
            {!canUseThisComputer(view) ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => window.wisp.activateConnection({ id: LOCAL_CONNECTION_ID }))}
              >
                Use this computer instead
              </Button>
            )}
          </div>
          {actionError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
        </section>
        {view.canManage === false ? null : (
          <section className="mt-4 rounded-2xl border border-border bg-card p-4" aria-label="Connections">
            <ConnectionsPanel view={view} />
          </section>
        )}
      </div>
    </main>
  );
}
