import { useEffect, useState } from "react";
import App from "@/App";
import type { WispApi } from "../../../shared/contracts";
import type { ConnectionApi, ConnectionState } from "../../../shared/connections";
import { BackendProvider } from "@/features/backend/backend-provider";
import { ConnectionsDialog, connectionStatus } from "./connections-dialog";
import { remoteOwner } from "@/features/backend/remote-owner";
import { Button } from "@/components/ui/button";

export function DesktopShell({ api, connections }: { api: WispApi; connections?: ConnectionApi }) {
  const [state, setState] = useState<ConnectionState>({
    phase: connections ? "connecting" : "local",
    profileId: "local",
    generation: 0,
  });
  const [name, setName] = useState("This computer");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!connections) return;
    let active = true;
    const unsubscribe = connections.subscribeToState((next) => {
      if (active) setState(next);
    });
    void connections.getState().then((result) => {
      if (active && result.ok) setState(result.value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [connections]);
  useEffect(() => {
    if (!connections) return;
    let active = true;
    void connections.list().then((result) => {
      if (active && result.ok) setName(result.value.find(({ id }) => id === state.profileId)?.name ?? "Remote server");
    });
    return () => {
      active = false;
    };
  }, [connections, state.profileId]);
  const usable = ["local", "connected", "reconnecting"].includes(state.phase);
  return (
    <>
      {usable ? (
        <BackendProvider
          key={`${state.profileId}:${state.serverId ?? "local"}:${state.generation}`}
          value={{
            api,
            desktop: api,
            instanceId: state.serverId ?? "local",
            remote: state.phase !== "local",
            writable: state.phase === "local" || state.phase === "connected",
            owner: state.owner ? remoteOwner(state.owner) : undefined,
          }}
        >
          <App
            onOpenConnections={connections ? () => setOpen(true) : undefined}
            connectionLabel={name}
            connectionMessage={state.message ?? connectionStatus(state)}
          />
        </BackendProvider>
      ) : (
        <main className="wisp-app flex h-full items-center justify-center p-6">
          <div className="grid max-w-md gap-4 text-center">
            <h1 className="text-xl font-semibold">Connect to your Wisps</h1>
            <p role="status">{state.message ?? connectionStatus(state)}</p>
            <Button onClick={() => setOpen(true)}>Open connections</Button>
          </div>
        </main>
      )}
      {connections ? (
        <ConnectionsDialog
          api={connections}
          state={state}
          open={open || ["pairing_required", "host_verification_required", "authenticating"].includes(state.phase)}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
