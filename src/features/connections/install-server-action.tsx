import { useState } from "react";
import { LoaderCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ConnectionsView } from "../../../shared/connections";
import { WISP_SERVER_PACKAGE } from "../../../shared/server-package";
import { SshPromptCard } from "./ssh-prompt-card";

/**
 * Sets the Wisp server up on the machine behind an SSH connection, by running
 * its setup there, and then connects to it. Asks first: it changes another
 * computer. Unless the connection was just checked, it checks it first, so
 * an unknown host key or a password is answered here rather than in a
 * terminal.
 */
export function InstallServerAction({
  view,
  profileId,
  host,
  label = "Install the Wisp server",
  disabled = false,
  checked = false,
  onInstalled,
}: {
  view: ConnectionsView;
  profileId: string;
  host: string;
  label?: string;
  disabled?: boolean;
  /** The connection was checked moments ago; skip checking it again. */
  checked?: boolean;
  onInstalled?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [step, setStep] = useState<"checking" | "installing" | null>(null);
  const [error, setError] = useState("");
  const progress = view.installation?.profileId === profileId ? view.installation.message : undefined;

  async function install() {
    setConfirming(false);
    setError("");
    try {
      if (!checked) {
        setStep("checking");
        const check = await window.wisp.checkSshServer({ id: profileId });
        if (!check.ok) {
          setError(check.error.message);
          return;
        }
      }
      setStep("installing");
      const result = await window.wisp.installServer({ id: profileId });
      if (result.ok) onInstalled?.();
      else setError(result.error.message);
    } catch {
      setError("The server could not be set up.");
    } finally {
      setStep(null);
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
            and starts a systemd user service. Without Node.js 22.19 or later there, it downloads one from nodejs.org.
            The machine needs systemd and internet access.
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
          <Button
            type="button"
            variant="outline"
            disabled={disabled || step !== null}
            onClick={() => setConfirming(true)}
          >
            {step ? (
              <>
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                {step === "checking" ? "Connecting…" : "Installing…"}
              </>
            ) : (
              label
            )}
          </Button>
        </div>
      )}
      {step === "checking" ? (
        <>
          {view.sshPrompt ? <SshPromptCard prompt={view.sshPrompt} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="m-0 text-xs text-dim">
              Connecting to {host} over SSH…
            </p>
            {view.sshPrompt ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={() => void window.wisp.cancelSshCheck()}>
                Cancel
              </Button>
            )}
          </div>
        </>
      ) : null}
      {step === "installing" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="m-0 text-xs text-dim">
            {progress ?? `Setting up ${host}. This can take a few minutes.`}
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
