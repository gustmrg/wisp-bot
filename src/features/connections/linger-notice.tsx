import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { ConnectionsView, SshConnectionProfile } from "../../../shared/connections";
import { SshPromptCard } from "./ssh-prompt-card";

/**
 * Shown when the setup could not turn on linger on a server: systemd stops
 * its Wisps whenever nobody is logged in there. Turns it on over SSH, asking
 * for the sudo password only if the machine needs it.
 */
export function LingerNotice({ view, profile }: { view: ConnectionsView; profile: SshConnectionProfile }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function enable() {
    setBusy(true);
    setError("");
    try {
      const result = await window.wisp.enableLinger({ id: profile.id });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Linger could not be turned on.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-2 mb-2 rounded-[10px] bg-warning-solid/10 px-3 py-2.5 text-xs leading-relaxed">
      <p className="m-0">
        Wisps on {profile.host} stop when you log out there. Wisp can keep them running, with{" "}
        <code>loginctl enable-linger</code>; it may ask for your sudo password.
      </p>
      {busy && view.sshPrompt ? <SshPromptCard prompt={view.sshPrompt} /> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void enable()}>
          {busy ? "Turning it on…" : "Keep them running"}
        </Button>
        {error ? (
          <p role="alert" className="m-0 text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
