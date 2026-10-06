import { useState } from "react";

import { ConfirmAction } from "@/components/settings/settings-primitives";
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
      <h2 id="connection-settings-title" className="mb-1 mt-0 text-[17px]">
        Connections
      </h2>
      <p className="mb-4 text-[11.5px] leading-relaxed text-dim" hidden={view?.canManage === false}>
        Choose where your Wisps run. On a Wisp server they keep working while this app is closed, and every paired
        device sees the same conversations. Settings, credentials, and approvals belong to the server you use.
      </p>
      {view?.canManage === false ? (
        <ServerSession view={view} />
      ) : view ? (
        <ConnectionsPanel view={view} />
      ) : error ? (
        <p role="alert" className="text-[11.5px] text-destructive">
          {error}
        </p>
      ) : (
        <p role="status" className="text-xs text-dim">
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
    <div className="animate-tab-forward">
      <p className="mb-4 text-[11.5px] leading-relaxed text-dim">
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
        <p role="alert" className="mt-3 text-[11.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
