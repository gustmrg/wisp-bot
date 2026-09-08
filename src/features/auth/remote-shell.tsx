import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
const App = lazy(() => import("@/App"));
import { RemoteBackendClient, validateRemoteEndpoint } from "../../../client/remote-backend-client";
import type { ConnectionState } from "../../../shared/connections";
import type { DeviceCredentials } from "../../../shared/remote-protocol";
import { BackendProvider } from "@/features/backend/backend-provider";
import { remoteOwner } from "@/features/backend/remote-owner";
import { clearInstanceDrafts } from "@/features/drafts/draft-storage";
import { connectionStatus } from "@/features/connections/connections-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const INITIAL: ConnectionState = { phase: "disconnected", profileId: "remote", generation: 0 };
export function RemoteShell({ mobile = false }: { mobile?: boolean }) {
  const [client, setClient] = useState<RemoteBackendClient | null>(null);
  const clientRef = useRef<RemoteBackendClient | null>(null);
  const [state, setState] = useState<ConnectionState>(INITIAL);
  const [endpoint, setEndpoint] = useState(mobile ? "" : window.location.origin);
  const [deviceName, setDeviceName] = useState(mobile ? "Wisp mobile" : "Wisp browser");
  const [pairingCode, setPairingCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [clearDrafts, setClearDrafts] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const resumePending = useRef(false);
  const selectedEndpoint = useRef(endpoint);

  const createClient = useCallback(
    (url: string, credentials?: DeviceCredentials) => {
      const baseUrl = validateRemoteEndpoint(url, !mobile && import.meta.env.DEV);
      selectedEndpoint.current = baseUrl;
      return new RemoteBackendClient({
        baseUrl,
        ...(credentials ? { expectedServerId: credentials.serverId } : {}),
        allowLoopbackHttp: !mobile && import.meta.env.DEV,
        auth: mobile
          ? {
              kind: "bearer",
              credentials,
              onCredentials: async (next) => {
                const store = await import("@/features/mobile/secure-session");
                await store.saveMobileSession(baseUrl, next);
              },
            }
          : { kind: "cookie" },
      });
    },
    [mobile],
  );
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = mobile ? await (await import("@/features/mobile/secure-session")).readMobileSession() : undefined;
        if (!active) return;
        if (mobile && !saved) return;
        const next = createClient(saved?.endpoint ?? window.location.origin, saved?.credentials);
        clientRef.current = next;
        setClient(next);
        if (saved) setEndpoint(saved.endpoint);
        await next.connect();
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        if (active) setInitialized(true);
      }
    })();
    return () => {
      active = false;
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [mobile, createClient]);
  useEffect(() => {
    if (!client) return;
    setState(client.getState());
    return client.subscribeToState(setState);
  }, [client]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    async function resume() {
      if (
        !active ||
        document.visibilityState === "hidden" ||
        resumePending.current ||
        !client?.getServer() ||
        ["pairing_required", "disconnected"].includes(client.getState().phase)
      )
        return;
      resumePending.current = true;
      setResuming(true);
      try {
        await client.resume();
        if (active) setError("");
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      } finally {
        resumePending.current = false;
        if (active) setResuming(false);
      }
    }
    const visible = () => {
      if (document.visibilityState === "visible") void resume();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visible);
    let nativeCleanup: (() => void) | undefined;
    if (mobile)
      void import("@capacitor/app").then(async ({ App: NativeApp }) => {
        const listener = await NativeApp.addListener("appStateChange", ({ isActive }) => {
          if (isActive) void resume();
        });
        const back = await NativeApp.addListener("backButton", () => {
          if (document.dispatchEvent(new Event("wisp:back", { cancelable: true }))) void NativeApp.minimizeApp();
        });
        if (!active) {
          await listener.remove();
          await back.remove();
        } else
          nativeCleanup = () => {
            void listener.remove();
            void back.remove();
          };
      });
    return () => {
      active = false;
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", visible);
      nativeCleanup?.();
    };
  }, [client, mobile]);

  async function pair(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    let next = client;
    try {
      if (!next || (mobile && validateRemoteEndpoint(endpoint) !== selectedEndpoint.current)) {
        next?.disconnect();
        next = createClient(endpoint);
        clientRef.current = next;
        setClient(next);
      }
      await next.pair(pairingCode.trim(), deviceName.trim());
      setPairingCode("");
      await next.connect();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function reconnect() {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      await client.resume();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      await client.logout();
    } catch {
      setError(
        "Signed out on this device. The server could not confirm revocation; revoke this device from another connection.",
      );
    } finally {
      if (clearDrafts && state.serverId) clearInstanceDrafts(state.serverId);
      setPairingCode("");
      setAccountOpen(false);
      setBusy(false);
      setState(INITIAL);
      if (mobile) {
        clientRef.current = null;
        setClient(null);
      }
    }
  }
  const usable = client && client.getSnapshot() && ["connected", "reconnecting", "error"].includes(state.phase);
  return (
    <>
      {usable ? (
        <Suspense
          fallback={
            <p className="p-6" role="status">
              Loading conversations…
            </p>
          }
        >
          <BackendProvider
            key={state.serverId}
            value={{
              api: client.api,
              instanceId: state.serverId ?? endpoint,
              remote: true,
              writable: state.phase === "connected" && !resuming,
              owner: state.owner ? remoteOwner(state.owner) : undefined,
              openAccount: () => setAccountOpen(true),
            }}
          >
            <App
              onOpenConnections={() => setAccountOpen(true)}
              connectionLabel={state.owner?.name ?? "Remote server"}
              connectionMessage={
                resuming ? "Synchronizing with the server…" : (state.message ?? connectionStatus(state))
              }
            />
          </BackendProvider>
        </Suspense>
      ) : (
        <main className="wisp-app flex h-full items-center justify-center overflow-y-auto p-6">
          <div className="my-auto grid w-full max-w-sm gap-4">
            <h1 className="text-2xl font-semibold">Connect to Wisp</h1>
            <p className="text-sm text-dim">
              {mobile
                ? "Connect Tailscale on this device, then enter your server’s HTTPS address."
                : "Pair this browser to load the conversations stored on this server."}
            </p>
            {!initialized ? (
              <p role="status">Loading your connection…</p>
            ) : (
              <form className="grid gap-4" onSubmit={(event) => void pair(event)}>
                {mobile ? (
                  <label className="grid gap-1.5 text-sm">
                    Server URL
                    <Input
                      type="url"
                      value={endpoint}
                      placeholder="https://wisp.your-tailnet.ts.net"
                      required
                      onChange={(event) => setEndpoint(event.target.value)}
                    />
                  </label>
                ) : (
                  <p className="break-all text-xs text-dim">{endpoint}</p>
                )}
                <label className="grid gap-1.5 text-sm">
                  Device name
                  <Input
                    value={deviceName}
                    maxLength={100}
                    required
                    onChange={(event) => setDeviceName(event.target.value)}
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  Pairing code
                  <Input
                    type="password"
                    autoComplete="off"
                    value={pairingCode}
                    required
                    onChange={(event) => setPairingCode(event.target.value)}
                  />
                </label>
                <p className="text-xs text-dim">
                  Generate a single-use code on the server with the Wisp administration CLI. Provider credentials remain
                  on the server.
                </p>
                <Button type="submit" disabled={busy || state.phase === "connecting"}>
                  {busy ? "Connecting…" : "Pair this device"}
                </Button>
                {client ? (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void reconnect()}>
                    Reconnect existing session
                  </Button>
                ) : null}
              </form>
            )}
            {error || state.message ? (
              <p className="text-sm text-destructive" role="alert">
                {error || state.message}
              </p>
            ) : null}
            {mobile && error ? (
              <Button
                variant="ghost"
                onClick={() =>
                  void (async () => {
                    try {
                      await (await import("@/features/mobile/secure-session")).saveMobileSession(endpoint, undefined);
                      client?.disconnect();
                      clientRef.current = null;
                      setClient(null);
                      setState(INITIAL);
                      setError("");
                    } catch (cause) {
                      setError(errorMessage(cause));
                    }
                  })()
                }
              >
                Forget the saved connection on this device
              </Button>
            ) : null}
          </div>
        </main>
      )}
      <Dialog open={accountOpen} onOpenChange={setAccountOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Server connection</DialogTitle>
            <DialogDescription>Your conversations and agents run on this server.</DialogDescription>
          </DialogHeader>
          <p className="break-all text-sm">{endpoint}</p>
          <p role="status" className="text-xs text-dim">
            {state.message ?? connectionStatus(state)}
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <Button variant="outline" disabled={busy} onClick={() => void reconnect()}>
            Reconnect and synchronize
          </Button>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={clearDrafts} onChange={(event) => setClearDrafts(event.target.checked)} />
            Clear this server’s drafts on this device when signing out
          </label>
          <Button variant="outline" disabled={busy} onClick={() => void logout()}>
            Sign out of this device
          </Button>
          <p className="text-xs text-dim">Signing out leaves remote agents running.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The server could not be reached.";
}
