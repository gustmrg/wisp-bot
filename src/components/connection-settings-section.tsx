import { useState } from "react";

import { ConfirmAction } from "@/components/settings/settings-primitives";
import { SettingsPanelTitle } from "@/components/settings/settings-scope";
import { ConnectionsPanel } from "@/features/connections/connections-panel";
import { useConnections } from "@/features/connections/connection-gate";
import type { ConnectionsView } from "../../shared/connections";

export function ConnectionSettingsSection() {
  const [view, error] = useConnections();
  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="connection-settings-panel"
      aria-labelledby="connection-settings-title"
    >
      <SettingsPanelTitle id="connection-settings-title" scope="device">
        Connections
      </SettingsPanelTitle>
      <p className="mb-4 text-xs leading-relaxed text-dim" hidden={view?.canManage === false}>
        Choose where your Wisps run. A Wisp server keeps them working with this app closed, and keeps its own settings
        and credentials.
      </p>
      {view?.canManage === false ? (
        <ServerSession view={view} />
      ) : view ? (
        <ConnectionsPanel view={view} />
      ) : error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p role="status" className="text-sm text-dim">
          Loading connections…
        </p>
      )}
    </section>
  );
}

/** The browser app's only connection: the server that served it. */
function ServerSession({ view }: { view: ConnectionsView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const server = view.profiles.find(({ id }) => id === view.activeId);
  async function signOut() {
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.removeConnection({ id: view.activeId });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Could not sign out.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        This browser uses the Wisps on {server?.name ?? "this server"}. Settings, credentials, and approvals belong to
        the server.
      </p>
      <ConfirmAction
        label="Sign out of this browser"
        confirmLabel="Sign out"
        pendingLabel="Signing out…"
        pending={busy}
        description="This browser forgets its pairing. Pair it again with a code from wispctl pair."
        onConfirm={() => void signOut()}
      />
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
