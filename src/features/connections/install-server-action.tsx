import { useState } from "react";
import { LoaderCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WISP_SERVER_PACKAGE } from "../../../shared/server-package";

/**
 * Sets the Wisp server up on the machine behind an SSH connection, by running
 * its setup there, and then connects to it. Asks first: it changes another
 * computer.
 */
export function InstallServerAction({
  profileId,
  host,
  label = "Install the Wisp server",
  disabled = false,
  onInstalled,
}: {
  profileId: string;
  host: string;
  label?: string;
  disabled?: boolean;
  onInstalled?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  async function install() {
    setConfirming(false);
    setInstalling(true);
    setError("");
    try {
      const result = await window.wisp.installServer({ id: profileId });
      if (result.ok) onInstalled?.();
      else setError(result.error.message);
    } catch {
      setError("The server could not be set up.");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div
          role="group"
          aria-label={label}
          className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-muted/40 p-3"
        >
          <p className="m-0 text-xs leading-relaxed">
            Wisp will connect to {host} over SSH and run <code>npx {WISP_SERVER_PACKAGE} setup</code> there. It installs
            the server in <code>~/.local/lib/wisp-server</code>, creates a master key in <code>~/.config/wisp</code>,
            and starts a systemd user service. The machine needs Node.js 22.19 or later and internet access.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void install()}>
              Install and connect
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="outline" disabled={disabled || installing} onClick={() => setConfirming(true)}>
            {installing ? (
              <>
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                Installing…
              </>
            ) : (
              label
            )}
          </Button>
        </div>
      )}
      {installing ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="m-0 text-xs text-dim">
            Setting up {host}. This can take a few minutes.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void window.wisp.cancelServerInstall()}>
            Cancel setup
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
