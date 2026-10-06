import { Fragment, useEffect, useState, type ReactNode } from "react";
import { LoaderCircleIcon, ServerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LOCAL_CONNECTION_ID, type ConnectionsView } from "../../../shared/connections";
import { ConnectionsPanel } from "./connections-panel";

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
        <div className="min-h-0 flex-1">
          <Fragment key={`${view.activeId}:${status.epoch}`}>{children}</Fragment>
        </div>
      </div>
    );
  }
  return <ConnectionScreen view={view} />;
}

function activeName(view: ConnectionsView): string {
  return view.profiles.find((profile) => profile.id === view.activeId)?.name ?? "the server";
}

function ReconnectingBanner({ view }: { view: ConnectionsView }) {
  return (
    <div
      role="status"
      className="flex flex-none items-center justify-center gap-3 bg-amber-500/15 px-4 py-1.5 text-[12px] text-foreground"
    >
      <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Reconnecting to {activeName(view)}. Wisps on it keep working.</span>
      <Button type="button" size="xs" variant="outline" onClick={() => void window.wisp.retryConnection()}>
        Retry now
      </Button>
    </div>
  );
}

function ConnectionMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm" role="alert">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-dim">{message}</p>
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
            <p role={status.phase === "error" ? "alert" : "status"} className="mt-2 text-sm leading-6 text-dim">
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
          <div className="mt-4 flex flex-wrap gap-2">
            {status.phase === "error" ? (
              <Button type="button" disabled={busy} onClick={() => void act(() => window.wisp.retryConnection())}>
                Retry
              </Button>
            ) : null}
            {view.activeId === LOCAL_CONNECTION_ID ? null : (
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
            <p role="alert" className="mt-3 text-[12px] text-destructive">
              {actionError}
            </p>
          ) : null}
        </section>
        <section className="mt-4 rounded-2xl border border-border bg-card p-4" aria-label="Connections">
          <ConnectionsPanel view={view} />
        </section>
      </div>
    </main>
  );
}
